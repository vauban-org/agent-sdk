/**
 * OODAAgentImpl — sequential while+sleep cycle loop with phase persistence,
 * guards, HITL gate, resource limits, and replay-safe context propagation.
 *
 * Implements all 10 anti-patterns enforced by-design (see `./types.ts`).
 *
 * @public
 */

import { randomUUID } from "node:crypto";
import type {
  CycleStatus,
  ExecutionMode,
  OODAAgent,
  OODAAgentConfig,
  OODAContext,
  PhaseDef,
  ResourceLimits,
  RiskGuard,
  SessionGuard,
} from "./types.js";
import { DEFAULT_RESOURCE_LIMITS } from "./types.js";
import { EMPTY_SKILL_REGISTRY } from "./skills.js";

/**
 * Noop logger fallback when host does not inject one.
 * Prevents TypeError: Cannot read properties of undefined (0.8.1 fix).
 */
const NOOP_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** Internal sleep helper — kept private so tests grep cannot find a global setInterval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Default in-memory step persister. Hosts MUST inject `insertStepImpl` /
 * `completeStepImpl` / `errorStepImpl` when persisting to Postgres.
 *
 * The default is intentionally trivial: it generates a UUID stepId and
 * a deterministic-but-fake leaf hash. This keeps the SDK runnable in
 * tests and dry-run hosts without requiring a DB.
 */
function defaultInsertStep(): OODAContext["insertStep"] {
  return async () => ({ stepId: randomUUID() });
}

function defaultCompleteStep(): OODAContext["completeStep"] {
  return async (stepId) => ({ leafHash: `0x${stepId.replace(/-/g, "")}` });
}

function defaultErrorStep(): OODAContext["errorStep"] {
  return async () => {};
}

function defaultNotifySlack(): OODAContext["notifySlack"] {
  return async () => {};
}

/**
 * Race a promise against an `AbortSignal.timeout`-driven rejection.
 * Anti-pattern #9 enforcement.
 */
function withPhaseTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`OODA phase timeout exceeded (${timeoutMs}ms)`));
    }, timeoutMs);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Validate phase definitions at construction time.
 * - observe + orient must be readOnly (anti-pattern #7)
 * - executionMode must be a known value (anti-pattern #6)
 */
function validateConfig(config: OODAAgentConfig): void {
  if (config.executionMode !== "dry-run" && config.executionMode !== "live") {
    throw new Error(
      `OODAAgent: executionMode is REQUIRED ('dry-run' | 'live') — got ${JSON.stringify(
        config.executionMode,
      )}`,
    );
  }
  if (config.phases.observe.readOnly !== true) {
    throw new Error(
      "OODAAgent: phases.observe MUST be readOnly:true (anti-pattern #7)",
    );
  }
  if (config.phases.orient.readOnly !== true) {
    throw new Error(
      "OODAAgent: phases.orient MUST be readOnly:true (anti-pattern #7)",
    );
  }
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 0) {
    throw new Error(
      `OODAAgent: intervalMs must be >= 0, got ${config.intervalMs}`,
    );
  }
}

/**
 * OODAAgentImpl — concrete implementation. Prefer `createOODAAgent` factory.
 */
export class OODAAgentImpl<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
> implements OODAAgent
{
  private readonly _config: OODAAgentConfig<
    TConfig,
    TObs,
    TOrient,
    TDecision,
    TAction,
    TFeedback
  >;
  private readonly _limits: Required<ResourceLimits>;
  private _running = false;
  private _cyclesCompleted = 0;
  private _lastCycleAt?: string;
  private _activeCycle?: Promise<unknown>;

  constructor(
    config: OODAAgentConfig<
      TConfig,
      TObs,
      TOrient,
      TDecision,
      TAction,
      TFeedback
    >,
  ) {
    validateConfig(config as OODAAgentConfig);
    this._config = config;
    this._limits = {
      phaseTimeoutMs:
        config.resourceLimits?.phaseTimeoutMs ??
        DEFAULT_RESOURCE_LIMITS.phaseTimeoutMs,
      maxStepsPerCycle:
        config.resourceLimits?.maxStepsPerCycle ??
        DEFAULT_RESOURCE_LIMITS.maxStepsPerCycle,
      maxHeapMb:
        config.resourceLimits?.maxHeapMb ?? DEFAULT_RESOURCE_LIMITS.maxHeapMb,
    };
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    // Anti-pattern #1 — sequential while + sleep. NEVER setInterval.
    while (this._running) {
      this._activeCycle = this.runCycle();
      await this._activeCycle;
      this._activeCycle = undefined;
      if (!this._running) break;
      await sleep(this._config.intervalMs);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    if (this._activeCycle) {
      try {
        await this._activeCycle;
      } catch {
        // Cycle errors already surfaced via runCycle's logging.
      }
    }
  }

  async triggerCycle(opts?: {
    dryRun?: boolean;
  }): Promise<{ runId: string; status: CycleStatus }> {
    const overrideMode: ExecutionMode | undefined =
      opts?.dryRun === true ? "dry-run" : undefined;
    return this.runCycle(overrideMode);
  }

  getStatus(): {
    running: boolean;
    lastCycleAt?: string;
    nextCycleAt?: string;
    cyclesCompleted: number;
  } {
    return {
      running: this._running,
      lastCycleAt: this._lastCycleAt,
      cyclesCompleted: this._cyclesCompleted,
    };
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private async runCycle(
    overrideMode?: ExecutionMode,
  ): Promise<{ runId: string; status: CycleStatus }> {
    const runId = randomUUID();
    const cycleIndex = this._cyclesCompleted;
    const executionMode = overrideMode ?? this._config.executionMode;
    const isReplay = false;
    // 0.8.1 fix: logger optional with noop default — was crashing in user code
    // if not injected (TypeError: Cannot read properties of undefined reading 'error').
    const logger = this._config.logger ?? NOOP_LOGGER;

    // Step counter — anti-pattern #9 (maxStepsPerCycle).
    let stepsThisCycle = 0;
    const limits = this._limits;

    const baseInsertStep =
      this._config.insertStepImpl ?? defaultInsertStep();
    const insertStep: OODAContext["insertStep"] = async (input) => {
      stepsThisCycle += 1;
      if (stepsThisCycle > limits.maxStepsPerCycle) {
        throw new Error(
          `OODA: maxStepsPerCycle exceeded (${limits.maxStepsPerCycle})`,
        );
      }
      return baseInsertStep(input);
    };

    // Hot-reload: if a configLoader is wired, refresh config from DB at cycle start.
    // TTL-based cache in the loader handles staleness. Falls back to static config.
    let liveConfig: TConfig = (this._config.config ?? ({} as TConfig)) as TConfig;
    if (this._config.configLoader) {
      try {
        liveConfig = await this._config.configLoader.get(this._config.agentId);
      } catch (e) {
        logger.warn(
          { agentId: this._config.agentId, err: (e as Error).message },
          "ooda.cycle.config_loader_failed — using static config",
        );
      }
    }

    const ctx: OODAContext<TConfig> = Object.freeze({
      agentId: this._config.agentId,
      runId,
      cycleIndex,
      executionMode,
      isReplay,
      config: liveConfig,
      configLoader: this._config.configLoader,
      db: this._config.db,
      skills: this._config.skills ?? EMPTY_SKILL_REGISTRY,
      logger,
      insertStep,
      completeStep: this._config.completeStepImpl ?? defaultCompleteStep(),
      errorStep: this._config.errorStepImpl ?? defaultErrorStep(),
      notifySlack: this._config.notifySlackImpl ?? defaultNotifySlack(),
    });

    // ── Session guards (anti-pattern #5 + #8) ────────────────────────────
    const sessionResult = await this._checkSessionGuards(
      this._config.sessionGuards ?? [],
    );
    if (!sessionResult.ok) {
      logger.info(
        { runId, agentId: this._config.agentId, reason: sessionResult.reason },
        "ooda.cycle.skipped.session_guard",
      );
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return { runId, status: "skipped" };
    }

    // ── Risk guards (anti-pattern #4 + #8) ───────────────────────────────
    const riskResult = await this._checkRiskGuards(
      this._config.riskGuards ?? [],
      ctx,
    );
    if (!riskResult.ok) {
      logger.info(
        { runId, agentId: this._config.agentId, reason: riskResult.reason },
        "ooda.cycle.skipped.risk_guard",
      );
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return { runId, status: "skipped" };
    }

    // ── Heap watermark (anti-pattern #10) ────────────────────────────────
    const heapMb = process.memoryUsage().heapUsed / (1024 * 1024);
    if (heapMb > limits.maxHeapMb) {
      logger.warn(
        { runId, heapMb, limitMb: limits.maxHeapMb },
        "ooda.cycle.heap_exceeded",
      );
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return { runId, status: "skipped" };
    }

    // ── Phase chain ──────────────────────────────────────────────────────
    try {
      const obs = await this._runPhase(
        this._config.phases.observe,
        undefined as void,
        ctx as OODAContext,
      );
      const oriented = await this._runPhase(
        this._config.phases.orient,
        obs as TObs,
        ctx as OODAContext,
      );
      const decision = await this._runPhase(
        this._config.phases.decide,
        oriented as TOrient,
        ctx as OODAContext,
      );
      const action = await this._runPhase(
        this._config.phases.act,
        decision as TDecision,
        ctx as OODAContext,
        { hitlGate: this._config.phases.act.hitlGate === true },
      );
      const feedback = await this._runPhase(
        this._config.phases.feedback,
        action as TAction,
        ctx as OODAContext,
      );

      // Outcome mapping (optional)
      if (this._config.outcomeMapping) {
        try {
          const outcome = this._config.outcomeMapping(feedback as TFeedback);
          if (outcome) {
            logger.info(
              { runId, outcome_type: outcome.outcome_type },
              "ooda.cycle.outcome",
            );
          }
        } catch (e) {
          logger.error(
            { runId, err: (e as Error).message },
            "ooda.cycle.outcome_mapping_failed",
          );
        }
      }

      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return { runId, status: "succeeded" };
    } catch (err) {
      logger.error(
        {
          runId,
          agentId: this._config.agentId,
          err: (err as Error).message,
        },
        "ooda.cycle.failed",
      );
      this._cyclesCompleted += 1;
      this._lastCycleAt = new Date().toISOString();
      return { runId, status: "failed" };
    }
  }

  private async _runPhase<I, O>(
    phase: PhaseDef<I, O>,
    input: I,
    ctx: OODAContext,
    opts?: { hitlGate?: boolean },
  ): Promise<O> {
    const step = await ctx.insertStep({
      type: phase.type,
      phase: phase.type,
      payload: { input_hash: hashPayload(input) },
    });
    try {
      const out = await withPhaseTimeout(
        phase.fn(input, ctx),
        this._limits.phaseTimeoutMs,
      );

      // HITL gate AFTER phase compute, BEFORE complete (act phase only).
      if (opts?.hitlGate === true && this._config.waitForHITL) {
        await this._config.waitForHITL({
          runId: ctx.runId,
          stepId: step.stepId,
          payload: out,
        });
      }

      await ctx.completeStep(step.stepId, {
        output_hash: hashPayload(out),
      });
      return out;
    } catch (err) {
      await ctx.errorStep(step.stepId, err as Error);
      throw err;
    }
  }

  private async _checkSessionGuards(
    guards: readonly SessionGuard[],
  ): Promise<{ ok: boolean; reason?: string }> {
    const now = new Date();
    for (const g of guards) {
      const active = await g.isActive(now);
      if (!active) return { ok: false, reason: `session:${g.name}` };
    }
    return { ok: true };
  }

  private async _checkRiskGuards(
    guards: readonly RiskGuard[],
    ctx: OODAContext,
  ): Promise<{ ok: boolean; reason?: string }> {
    for (const g of guards) {
      const r = await g.check(ctx);
      if (!r.proceed) {
        return { ok: false, reason: `risk:${g.name}:${r.reason ?? "tripped"}` };
      }
    }
    return { ok: true };
  }
}

/** Cheap structural hash — just JSON length + first chars, NOT crypto. */
function hashPayload(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return "null";
    return `len=${s.length}:${s.slice(0, 32)}`;
  } catch {
    return "unserializable";
  }
}
