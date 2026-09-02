/**
 * Agent — unified runtime with strategy plug-ins.
 *
 * Replaces the legacy split between {@link OODAAgentImpl} (full ceremony,
 * OODA-only) and the inline preste loops (`standalone-react-loop.ts`,
 * `standalone-plan-loop.ts`). One class, four strategies :
 *
 *   - `ooda`     — Observe → Orient → Decide → Act → (Reflect?) → Feedback
 *   - `react`    — Thought → Action → Observe (text protocol + JSON fallback)
 *   - `plan`     — Plan → Execute → Synthesize
 *   - `one-shot` — Single LLM call, no tool loop
 *
 * Hooks (skillCapture, onStep, attestation) run uniformly across all
 * strategies. Strategies remain pure : they invoke `ctx.tools` + `ctx.llmFn`
 * and return an {@link AgentCycleResult}, nothing else.
 *
 * @public @experimental @since 2.0.0
 */

import { randomUUID } from "node:crypto";
import type { ActionGate, ActionGateVerdict } from "../permissions/action-gate.js";
import type { LLMProviderPort } from "../ports/llm-provider.js";
import type { LoggerPort } from "../ports/logger.js";
import {
  createOneShotStrategy,
  createPlanStrategy,
  createReactStrategy,
} from "../strategies/index.js";
import {
  type OODACycleInvoker,
  createOODAStrategy,
  createUnconfiguredOODAInvoker,
} from "../strategies/ooda.js";
import type {
  AgentContext,
  AgentCycleResult,
  AgentHooks,
  AgentStrategy,
  AgentStrategyName,
  StrategyLLMCompletionFn,
  StrategyStepEvent,
} from "../strategies/types.js";
import type { ToolRegistry } from "../tools/types.js";
import { captureSkillFromCycle } from "./ooda/skill-capture.js";
import type { SkillCaptureOptions } from "./ooda/skill-capture.js";
import type { OutcomeRecord } from "./ooda/types.js";

const NOOP_LOGGER: LoggerPort = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Configuration for the unified Agent.
 *
 * @public @experimental @since 2.0.0
 */
export interface AgentConfig {
  /** Agent identifier — used for telemetry, skill capture, etc. */
  readonly agentId: string;
  /** Agent version string. Defaults to "0.0.0". */
  readonly agentVersion?: string;
  /** Strategy to use. Default: `"ooda"`. */
  readonly strategy?: AgentStrategyName | AgentStrategy;
  /** System prompt baseline. Strategies may augment it. */
  readonly systemPrompt: string;
  /** Tool registry. */
  readonly tools: ToolRegistry;
  /** LLM port (used by ooda strategy when wired). */
  readonly llm?: LLMProviderPort;
  /**
   * Lower-level completion function consumed by react / plan / one-shot.
   * MUST be provided when using any non-ooda strategy.
   */
  readonly llmFn?: StrategyLLMCompletionFn;
  /** Maximum steps per cycle. Default: 10. */
  readonly maxSteps?: number;
  /** Optional logger. Falls back to noop. */
  readonly logger?: LoggerPort;
  /** Optional allowlist of tool names to expose to the strategy. */
  readonly allowedTools?: readonly string[];
  /** Hook bundle. */
  readonly hooks?: AgentHooks;
  /** Abort signal forwarded to the strategy. */
  readonly signal?: AbortSignal;
  /**
   * For the OODA strategy : an externally-built invoker that wraps an
   * existing {@link OODAAgentImpl}. Required when `strategy === "ooda"` and
   * the consumer needs the full OODA lifecycle.
   */
  readonly oodaInvoker?: OODACycleInvoker;
  /**
   * Optional skill capture (Hermes Procedural Learning Loop). Fires after
   * a successful cycle when `outcome.quality >= minQuality`.
   */
  readonly skillCapture?: SkillCaptureOptions;
  /**
   * Outcome mapping — strategies don't compute this themselves. Receives
   * the cycle result and produces an optional outcome record used by
   * skillCapture + downstream telemetry.
   */
  readonly outcomeMapping?: (result: AgentCycleResult) => OutcomeRecord | null;
  /**
   * Optional governed output gate (CC tier-gate). When set, a successfully
   * completed cycle's final output is verified BEFORE the run is accepted ; a
   * denied verdict fails the run closed (stopReason `"blocked"`, empty
   * finalMessage) with the gate's reason surfaced via `onOutputDenied`.
   *
   * Mirrors the preste pre-act ActionGate (loop/minimal-loop.ts) ; the canonical
   * backing is `batteryActionGate()` (a governed VerifierBattery). Opt-in :
   * absent leaves current behavior untouched. The cycle is presented as the
   * single ActionGateCall `{ toolName: "agent.cycle", args: { finalMessage,
   * strategy, stepCount }, budgetUsed: 0 }`.
   */
  readonly outputGate?: ActionGate;
  /**
   * Optional observer fired when `outputGate` denies a cycle. Receives the
   * run id, the human-readable reason (Art. 14), and the gate's opaque audit
   * step. Best-effort ; errors thrown by this callback are swallowed.
   */
  readonly onOutputDenied?: (event: {
    runId: string;
    reason: string;
    auditStep?: unknown;
  }) => void;
}

/**
 * Result returned by {@link Agent.run}.
 *
 * @public @experimental @since 2.0.0
 */
export interface AgentRunResult {
  readonly runId: string;
  readonly agentId: string;
  readonly strategy: AgentStrategyName;
  readonly finalMessage: string;
  readonly stopReason: AgentCycleResult["stopReason"];
  readonly stepCount: number;
  readonly tokensUsed: { in: number; out: number };
  readonly durationMs: number;
  readonly outcome?: OutcomeRecord;
  readonly stepsTrace?: readonly unknown[];
  readonly model?: string;
  readonly provider?: string;
  /** Whether a skill was captured during this run (if skillCapture enabled). */
  readonly skillCaptured?: boolean;
}

function resolveStrategy(cfg: AgentConfig): {
  strategy: AgentStrategy;
  name: AgentStrategyName;
} {
  const s = cfg.strategy ?? "ooda";
  if (typeof s !== "string") {
    return { strategy: s, name: s.name };
  }
  switch (s) {
    case "ooda":
      return {
        strategy: createOODAStrategy(cfg.oodaInvoker ?? createUnconfiguredOODAInvoker()),
        name: "ooda",
      };
    case "react":
      return { strategy: createReactStrategy(), name: "react" };
    case "plan":
      return { strategy: createPlanStrategy(), name: "plan" };
    case "one-shot":
      return { strategy: createOneShotStrategy(), name: "one-shot" };
    default: {
      const _exhaustive: never = s;
      throw new Error(`Unknown strategy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * The unified Agent — single runtime, four strategies, all hooks.
 *
 * @public @experimental @since 2.0.0
 */
export class Agent {
  private readonly cfg: AgentConfig;
  private readonly strategy: AgentStrategy;
  private readonly strategyName: AgentStrategyName;
  private readonly logger: LoggerPort;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    const resolved = resolveStrategy(cfg);
    this.strategy = resolved.strategy;
    this.strategyName = resolved.name;
    this.logger = cfg.logger ?? NOOP_LOGGER;
  }

  /**
   * Execute one full cycle of the configured strategy and return the result.
   *
   * Fires hooks uniformly across strategies :
   *   - `onStep` is invoked by each strategy on every meaningful phase.
   *   - skillCapture fires after a successful cycle when configured + quality met.
   */
  async run(task: string): Promise<AgentRunResult> {
    const runId = randomUUID();
    const startedAt = Date.now();
    const maxSteps = this.cfg.maxSteps ?? 10;

    // Wrap hooks to inject `strategy` into every event.
    const wrappedHooks: AgentHooks | undefined = this.cfg.hooks
      ? {
          ...(this.cfg.hooks.onStep
            ? {
                onStep: async (event: StrategyStepEvent) => {
                  try {
                    await this.cfg.hooks?.onStep?.({
                      ...event,
                      strategy: this.strategyName,
                    });
                  } catch (err) {
                    this.logger.warn?.(
                      {
                        runId,
                        err: (err as Error)?.message ?? String(err),
                      },
                      "agent.onStep_failed",
                    );
                  }
                },
              }
            : {}),
          ...(this.cfg.hooks.onPhaseComplete
            ? {
                onPhaseComplete: (phase: string, output: unknown) => {
                  try {
                    this.cfg.hooks?.onPhaseComplete?.(phase, output);
                  } catch (err) {
                    this.logger.warn?.(
                      {
                        runId,
                        err: (err as Error)?.message ?? String(err),
                      },
                      "agent.onPhaseComplete_failed",
                    );
                  }
                },
              }
            : {}),
        }
      : undefined;

    const ctx: AgentContext = {
      task,
      systemPrompt: this.cfg.systemPrompt,
      tools: this.cfg.tools,
      ...(this.cfg.llm ? { llm: this.cfg.llm } : {}),
      ...(this.cfg.llmFn ? { llmFn: this.cfg.llmFn } : {}),
      maxSteps,
      logger: this.logger,
      ...(this.cfg.allowedTools ? { allowedTools: this.cfg.allowedTools } : {}),
      ...(wrappedHooks ? { hooks: wrappedHooks } : {}),
      ...(this.cfg.signal ? { signal: this.cfg.signal } : {}),
      runId,
      agentId: this.cfg.agentId,
    };

    let result: AgentCycleResult;
    try {
      result = await this.strategy.run(ctx);
    } catch (err) {
      this.logger.error?.(
        {
          runId,
          agentId: this.cfg.agentId,
          strategy: this.strategyName,
          err: (err as Error)?.message ?? String(err),
        },
        "agent.run_failed",
      );
      return {
        runId,
        agentId: this.cfg.agentId,
        strategy: this.strategyName,
        finalMessage: "",
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: 0, out: 0 },
        durationMs: Date.now() - startedAt,
      };
    }

    // ─── Output gate (governed VerifierBattery tier-gate) ; fail-closed. ──────
    // Only a successfully completed cycle is subject to the gate : a producer
    // cannot "commit" its output until the orchestrator's verifiers pass. A
    // non-complete cycle already failed for another reason and passes through.
    if (this.cfg.outputGate && result.stopReason === "complete") {
      let verdict: ActionGateVerdict;
      try {
        verdict = await this.cfg.outputGate.verify({
          toolName: "agent.cycle",
          args: {
            finalMessage: result.finalMessage,
            strategy: this.strategyName,
            stepCount: result.stepCount,
          },
          // No per-cycle USD figure at this layer ; budget-aware lenses gate
          // pre-act in preste (minimal-loop.ts), not here.
          budgetUsed: 0,
        });
      } catch (err) {
        verdict = {
          allowed: false,
          reason: `output_gate_error: ${(err as Error)?.message ?? String(err)}`,
        };
      }
      if (!verdict.allowed) {
        try {
          this.cfg.onOutputDenied?.({
            runId,
            reason: verdict.reason,
            auditStep: verdict.auditStep,
          });
        } catch {
          // best-effort
        }
        this.logger.warn?.(
          { runId, agentId: this.cfg.agentId, reason: verdict.reason },
          "agent.output_denied",
        );
        return {
          runId,
          agentId: this.cfg.agentId,
          strategy: this.strategyName,
          finalMessage: "",
          stopReason: "blocked",
          stepCount: result.stepCount,
          tokensUsed: result.tokensUsed,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    // Outcome mapping.
    let outcome: OutcomeRecord | null = result.outcome ?? null;
    if (this.cfg.outcomeMapping) {
      try {
        outcome = this.cfg.outcomeMapping(result) ?? outcome;
      } catch (err) {
        this.logger.warn?.(
          {
            runId,
            err: (err as Error)?.message ?? String(err),
          },
          "agent.outcomeMapping_failed",
        );
      }
    }

    // Skill capture — fire after a successful cycle.
    let skillCaptured = false;
    if (this.cfg.skillCapture?.enabled && result.stopReason === "complete") {
      try {
        const trigger = {
          toolCallCount: result.stepCount,
          roi: outcome?.value_cents ? outcome.value_cents / 100 : 0,
          durationMs: Date.now() - startedAt,
          wasReplay: false,
        };
        const traceSummary = `Run ${runId} ${this.cfg.agentId} [${this.strategyName}]: ${result.stepCount} steps`;
        const captureResult = await captureSkillFromCycle(
          this.cfg.agentId,
          runId,
          trigger,
          outcome,
          traceSummary,
          this.cfg.skillCapture,
          this.logger,
        );
        skillCaptured = captureResult.captured;
      } catch (err) {
        this.logger.warn?.(
          {
            runId,
            err: (err as Error)?.message ?? String(err),
          },
          "agent.skill_capture_failed",
        );
      }
    }

    return {
      runId,
      agentId: this.cfg.agentId,
      strategy: this.strategyName,
      finalMessage: result.finalMessage,
      stopReason: result.stopReason,
      stepCount: result.stepCount,
      tokensUsed: result.tokensUsed,
      durationMs: Date.now() - startedAt,
      ...(outcome ? { outcome } : {}),
      ...(result.stepsTrace ? { stepsTrace: result.stepsTrace } : {}),
      ...(result.model ? { model: result.model } : {}),
      ...(result.provider ? { provider: result.provider } : {}),
      skillCaptured,
    };
  }

  /** Read-only accessor — the strategy this Agent was constructed with. */
  get strategyKind(): AgentStrategyName {
    return this.strategyName;
  }
}

/**
 * Factory for the unified Agent.
 *
 * @public @experimental @since 2.0.0
 */
export function createAgent(cfg: AgentConfig): Agent {
  return new Agent(cfg);
}
