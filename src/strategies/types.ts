/**
 * Strategy plug-in types for the unified `Agent` runtime.
 *
 * The four canonical strategy names :
 *   - `ooda`     — Observe → Orient → Decide → Act → (Reflect?) → Feedback
 *   - `react`    — Thought → Action → Observe (text protocol + JSON fallback)
 *   - `plan`     — Plan → Execute → Synthesize (upfront planning)
 *   - `one-shot` — Single LLM call, no tool loop
 *
 * Strategies are pure data-flow plug-ins. Hooks (skillCapture, onStep,
 * HITL approval, attestation) are invoked by the parent `Agent` class
 * around `strategy.run(ctx)`, never by the strategy itself.
 *
 * @public @experimental @since 2.0.0
 */

import type { OutcomeRecord, StepEvent } from "../orchestration/ooda/types.js";
import type { LLMProviderPort } from "../ports/llm-provider.js";
import type { LoggerPort } from "../ports/logger.js";
import type { ToolRegistry } from "../tools/types.js";

/**
 * Chat-style message used by text-protocol strategies (react, plan, one-shot).
 *
 * @public
 */
export interface StrategyMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/**
 * Structured tool call extracted by a strategy (text or function-calling
 * protocol).
 *
 * @public
 */
export interface StrategyToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Provider-agnostic LLM response surface consumed by react/plan/one-shot
 * strategies. Keep this distinct from the SDK's internal LLMProviderPort so
 * strategies remain trivially testable without the full SDK port stack.
 *
 * @public
 */
export interface StrategyLLMResponse {
  readonly content: string;
  readonly toolCalls?: readonly StrategyToolCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
  readonly provider: string;
}

/**
 * Completion function consumed by strategies. Identical shape to the preste
 * `LLMCompletionFn` so ported logic round-trips without modification.
 *
 * @public
 */
export type StrategyLLMCompletionFn = (
  messages: readonly StrategyMessage[],
) => Promise<StrategyLLMResponse>;

/**
 * Canonical strategy identifiers.
 *
 * @public
 */
export type AgentStrategyName = "ooda" | "react" | "plan" | "one-shot";

/**
 * Phase event surfaced via `AgentContext.hooks.onStep`.
 *
 * Stable shape across strategies : strategies emit `phase` labels that may
 * differ but the event envelope is uniform.
 *
 * @public @experimental
 */
export interface StrategyStepEvent extends StepEvent {
  /** Strategy that emitted the event (ooda / react / plan / one-shot). */
  readonly strategy: AgentStrategyName;
}

/**
 * Hooks fired around strategy execution. All hooks are fail-soft : errors
 * thrown by user code are logged but never abort the cycle.
 *
 * @public @experimental
 */
export interface AgentHooks {
  /** Fired after each meaningful phase (one or many per strategy cycle). */
  readonly onStep?: (event: StrategyStepEvent) => void | Promise<void>;
  /** Fired when a strategy completes a logical phase. */
  readonly onPhaseComplete?: (phase: string, output: unknown) => void;
}

/**
 * Per-cycle context passed to a strategy's `run()` method.
 *
 * Strict invariants :
 * - `tools` and `llm` are provided. A strategy MUST NOT mutate them.
 * - `hooks` are optional ; strategies invoke them on every meaningful event.
 * - `signal` is an AbortSignal that callers may use to cancel.
 *
 * @public @experimental
 */
export interface AgentContext {
  /** The user-supplied task / prompt. */
  readonly task: string;
  /** Resolved system prompt (after any strategy-specific prefix). */
  readonly systemPrompt: string;
  /** Tool registry, scoped for the cycle. */
  readonly tools: ToolRegistry;
  /** Direct LLM port (alternative to llmFn). */
  readonly llm?: LLMProviderPort;
  /**
   * Lower-level completion function. Strategies that ported from preste
   * (react / plan) consume `llmFn` ; strategies that ported from the SDK
   * (ooda) consume `llm`. Both are supported during the migration.
   */
  readonly llmFn?: StrategyLLMCompletionFn;
  /** Hard cap on the number of steps the strategy is allowed to take. */
  readonly maxSteps: number;
  /** Logger ; never undefined — falls back to noop in absent host. */
  readonly logger: LoggerPort;
  /** Optional set of tools allowlisted for this cycle (subset of `tools`). */
  readonly allowedTools?: readonly string[];
  /** Hook bundle. */
  readonly hooks?: AgentHooks;
  /** Abort signal — strategies SHOULD honor it on long-running ops. */
  readonly signal?: AbortSignal;
  /** Run identifier (UUID v4). */
  readonly runId: string;
  /** Agent identifier. */
  readonly agentId: string;
}

/**
 * Result of a single strategy cycle.
 *
 * Strategies return their final user-visible message in `finalMessage` and
 * accumulated step/cost stats. The Agent class may transform this into an
 * {@link AgentRunResult} for consumer-friendly shapes.
 *
 * @public @experimental
 */
export interface AgentCycleResult {
  /** Final assistant message. */
  readonly finalMessage: string;
  /**
   * Why the cycle ended. `"blocked"` = a governed output gate (CC tier-gate)
   * denied the cycle's output fail-closed (see {@link AgentConfig.outputGate}).
   */
  readonly stopReason:
    | "complete"
    | "max_steps"
    | "error"
    | "user_cancelled"
    | "skipped"
    | "blocked";
  /** Number of internal steps consumed by the strategy. */
  readonly stepCount: number;
  /** Aggregate token usage across all LLM calls in the cycle. */
  readonly tokensUsed: { in: number; out: number };
  /** Optional outcome captured by the strategy (used by skillCapture). */
  readonly outcome?: OutcomeRecord;
  /** Optional steps trace (used for trajectory export). */
  readonly stepsTrace?: readonly unknown[];
  /** Optional model identifier used (last seen). */
  readonly model?: string;
  /** Optional provider identifier used (last seen). */
  readonly provider?: string;
}

/**
 * Strategy plug-in contract.
 *
 * A strategy is purely functional. The Agent class wraps `run()` and is
 * responsible for ALL side-effects : skillCapture, attestation, HITL approval,
 * trajectory persistence.
 *
 * @public @experimental
 */
export interface AgentStrategy {
  /** Canonical strategy name. */
  readonly name: AgentStrategyName;
  /** Execute one full strategy cycle. */
  run(ctx: AgentContext): Promise<AgentCycleResult>;
}
