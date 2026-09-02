/**
 * OODA Orchestration — Public Types (sprint-525:quick-1 foundation).
 *
 * The OODA primitive is the single, opinionated agent lifecycle for CC v2:
 *   observe → orient → decide → act → feedback
 *
 * 10 anti-patterns are enforced **by-design** through the API surface and
 * runtime validation in `OODAAgentImpl`:
 *
 *   1. Sequential `while + sleep` cycle loop — never `setInterval`.
 *   2. Each phase persists `pending` → `done` via `insertStep` + `completeStep`.
 *   3. Optional `hitlGate` on `act` — gates execution until human approval.
 *   4. Risk guards have NO TTL bypass — each cycle re-checks.
 *   5. Session guards checked once per cycle; cycle SKIPPED if any false.
 *   6. `executionMode` is REQUIRED at construction — no implicit default.
 *   7. `observe` and `orient` MUST be `readOnly: true`.
 *   8. On any guard tripped, the cycle aborts cleanly — no LLM/skill calls.
 *   9. Resource limits (`phaseTimeoutMs`, `maxStepsPerCycle`, `maxHeapMb`)
 *      are configurable with sane defaults (60s / 200 / 256MB).
 *  10. Heap & step usage are monitored and exceeding limits is logged + aborted.
 *
 * Replay safety: every `OODAContext` carries `isReplay`. Skills and phase
 * functions MUST honor it (no observable side effects when true).
 *
 * Type-safe phase chaining: each phase's `TOutput` becomes the next phase's
 * `TInput`, providing compile-time guarantees on the data flow.
 *
 * @public
 */

import type { AgentRegistryPort } from "../../ports/agent-registry.js";
import type { BrainPort } from "../../ports/brain.js";
import type { EventBusPort } from "../../ports/event-bus.js";
import type { HITLPort } from "../../ports/hitl.js";
import type { KeyProvider } from "../../ports/key-provider.js";
import type { LLMProviderPort } from "../../ports/llm-provider.js";
import type { LoggerPort } from "../../ports/logger.js";
import type { MessagingChannelPort } from "../../ports/messaging.js";
import type { TimestampPort } from "../../ports/timestamp.js";
import type { ReceiptQueue } from "../../proof/receipt-queue.js";
import type { DbClient } from "../../tracking/agent-run-tracker.js";
import type { AgentConfigLoader } from "./agent-config-loader.js";
import type { SkillRegistry } from "./skills.js";

/**
 * OODA dependency bundle — BYOM (Bring Your Own Model) injection contract.
 *
 * Plan v6 §3.7: all port dependencies are injected at construction, never
 * resolved internally. Enables BYOM adapters, testability, and isolation.
 *
 * In SDK 0.17: `deps` is optional for backward compat with legacy configs.
 * In SDK 1.0: `deps` will be required and `deps.llm` must be present.
 *
 * Strict mode (default): `SDK_STRICT_DEPS !== "false"` → throws
 * `MissingDependencyError` if `deps.llm` is absent at boot.
 *
 * @public
 */
export interface OODAAgentDeps {
  /** REQUIRED in strict mode. The LLM provider used by phases for completions. */
  llm: LLMProviderPort;
  /** Optional. Event bus for inter-agent and cross-product events (ADR-ECO-017). Will be required in 1.0. */
  eventBus?: EventBusPort;
  /** Optional. Human-in-the-loop state machine. Will be required in 1.0. */
  hitl?: HITLPort;
  /** Optional. Messaging channels (Slack, Telegram, Discord, Console, MCP). */
  messaging?: MessagingChannelPort;
  /** Optional. Brain memory tiers (working, episodic, semantic, procedural). */
  memory?: BrainPort;
  /** Optional. Agent discovery registry. */
  registry?: AgentRegistryPort;
}

/**
 * The five OODA phase kinds. Mirrors the four `RunStep.type` values in
 * `proof/types.ts` plus the `observation` legacy variant — kept aligned so
 * step rows persisted through `OODAContext.insertStep` flow cleanly into
 * the proof certificate pipeline.
 * @public
 */
export type OODAPhaseKind = "retrieval" | "decision" | "execution" | "feedback" | "observation";

/**
 * Execution mode — REQUIRED at construction. Anti-pattern #6: no default.
 *
 * - `dry-run`: phases run, skills consult `dryRunMocks`, no production
 *   side-effects (no Brain writes, no on-chain tx, no Slack live).
 * - `live`: full production execution.
 * @public
 */
export type ExecutionMode = "dry-run" | "live";

/**
 * OODAContext — passed to every phase function and every skill invocation.
 *
 * Strictly read-only (`readonly` on all fields) so phase functions cannot
 * mutate it. Mutation helpers (`insertStep`, `completeStep`, `errorStep`,
 * `notifySlack`) are the ONLY sanctioned side-effect path.
 *
 * `isReplay` flag enables replay-safe execution: skills/phases MUST
 * short-circuit observable side-effects when true.
 * @public
 */
export interface OODAContext<TConfig = unknown> {
  readonly agentId: string;
  readonly runId: string;
  /** Zero-indexed cycle counter (0 for first cycle of a `start()` session). */
  readonly cycleIndex: number;
  readonly executionMode: ExecutionMode;
  readonly isReplay: boolean;
  readonly config: TConfig;
  /**
   * Optional hot-reload config loader. When present, `OODAAgentImpl` calls
   * `configLoader.get(agentId)` at the start of each cycle and surfaces the
   * result as `ctx.config` for that cycle. Change config in DB → next cycle
   * after TTL expiry picks it up without restart.
   */
  readonly configLoader?: AgentConfigLoader<TConfig>;
  readonly db: DbClient;
  readonly skills: SkillRegistry;
  readonly logger: LoggerPort;
  /**
   * Injected dependencies (BYOM — plan v6 §3.7).
   * Phases access ports via `ctx.deps.llm.complete(...)` etc.
   * Empty object `{}` in legacy mode (when `config.deps` is absent).
   */
  readonly deps: Partial<OODAAgentDeps>;

  /**
   * DB id of the `run_step` row WRAPPING the currently-executing phase, injected by
   * the OODA runtime for the duration of `phase.fn`. Lets a phase tie a side artifact
   * it persists (e.g. an `agent_decision_proof` row) back to its own step, so an
   * external verdict on that artifact can later surface on the step. `undefined`
   * outside a phase, or under trivial harnesses that do not persist steps.
   */
  readonly stepId?: string;

  /** Persist a `pending` step row — anti-pattern #2 first half. */
  readonly insertStep: (input: {
    type: OODAPhaseKind;
    phase: string;
    payload?: Record<string, unknown>;
  }) => Promise<{ stepId: string }>;

  /** Mark a step `done` and emit `leafHash` — anti-pattern #2 second half. */
  readonly completeStep: (
    stepId: string,
    payload: Record<string, unknown>,
  ) => Promise<{ leafHash: string }>;

  /** Mark a step `error` (no leaf hash). */
  readonly errorStep: (stepId: string, error: Error) => Promise<void>;

  /** Routed Slack notification (no-op in dry-run / replay). */
  readonly notifySlack: (channel: string, text: string) => Promise<void>;

  /**
   * Fire-and-forget plan checkpoint helper (SDK 1.6.1).
   *
   * Factorises the `insertStep → completeStep | errorStep` boilerplate that
   * forge phases (publish_x, attest_run, hitl_pause, archive_brain, …) repeat
   * in every `act` phase. Equivalent to :
   *
   * ```ts
   * (async () => {
   *   const { stepId } = await ctx.insertStep({ type, phase, payload });
   *   if (status === "failed") await ctx.errorStep(stepId, errorAsError);
   *   else                     await ctx.completeStep(stepId, { ...payload, status });
   * })().catch((err) => ctx.logger.warn?.({ err }, "[emitStep] failed"));
   * ```
   *
   * Semantics :
   * - Caller-side : synchronous, never throws, never blocks (errors are swallowed
   *   and surfaced via `ctx.logger.warn`).
   * - `status` defaults to `"completed"`.
   * - `status: "failed"` → `errorStep(stepId, error)`. `error` may be `Error` or
   *   `string` ; strings are wrapped via `new Error(string)`.
   * - `status: "completed" | "skipped"` → `completeStep(stepId, {...payload, status})`.
   * - Honours `resourceLimits.maxStepsPerCycle` (delegates to `insertStep`).
   *
   * Side-effect: existing `insertStep` / `completeStep` / `errorStep` remain
   * exposed. `emitStep` is additive sucre — no breaking change.
   */
  readonly emitStep: (input: {
    type: OODAPhaseKind;
    phase: string;
    payload?: Record<string, unknown>;
    status?: "completed" | "failed" | "skipped";
    error?: Error | string;
  }) => void;
}

/**
 * PhaseDef — pure(ish) function from `TInput` to `TOutput` plus metadata.
 *
 * Constructor enforces `readOnly: true` on `observe` and `orient` phases.
 * The `hitlGate` flag is only meaningful on `act`; ignored elsewhere.
 * @public
 */
export interface PhaseDef<TInput, TOutput> {
  readonly type: OODAPhaseKind;
  /** When true, phase is forbidden to call mutation helpers / live skills. */
  readonly readOnly?: boolean;
  /** Only respected on `act`. When true, awaits HITL approval. */
  readonly hitlGate?: boolean;
  readonly fn: (input: TInput, ctx: OODAContext) => Promise<TOutput>;
}

/**
 * SessionGuard — gates whether a cycle should run at all (e.g. market
 * sessions, business hours). `isActive(now)` returning false → cycle skipped.
 * @public
 */
export interface SessionGuard {
  readonly name: string;
  isActive(at: Date): Promise<boolean>;
}

/**
 * RiskGuard — per-cycle adversarial check (e.g. circuit breaker tripped,
 * KYC stale, budget exhausted). `proceed: false` → cycle skipped.
 *
 * Anti-pattern #4: NO TTL bypass — guards are consulted on EVERY cycle.
 * @public
 */
export interface RiskGuard {
  readonly name: string;
  check(ctx: OODAContext): Promise<{ proceed: boolean; reason?: string }>;
}

/**
 * OutcomeRecord — optional output of `outcomeMapping(feedback)`. Persisted
 * as an outcome row attributable to this run.
 * @public
 */
export interface OutcomeRecord {
  readonly outcome_type: string;
  readonly value_cents: number;
  /** Confidence score (0.0 - 1.0). EconomicObserver weights ROI by confidence. */
  readonly confidence?: number;
  /**
   * Outcome quality score (0.0 - 1.0). Distinct from confidence : measures
   * the BUSINESS quality of the cycle output (publishedCount, threatsBlocked,
   * invoicesProcessed, etc.). Persisted to `agent_run.outcome_quality` by
   * the CC backend's telemetry-ingest finish handler (SDK 1.6 / ADR-ECO-039).
   * Use the SDK's `computeQuality()` helper (or `computeQualityWithBreakdown()`
   * for debug-grade observability) for consistent scoring across agents, or
   * override with a custom score. See `@vauban-org/agent-sdk` quality module.
   */
  readonly quality?: number;
  readonly is_pending_backfill?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Resource limits — anti-pattern #9 + #10. Defaults applied when omitted.
 * @public
 */
export interface ResourceLimits {
  /** Per-phase wall-clock timeout. Default: 60_000 ms. */
  readonly phaseTimeoutMs?: number;
  /** Hard cap on `insertStep` calls per cycle. Default: 200. */
  readonly maxStepsPerCycle?: number;
  /** Soft heap watermark — log+abort if exceeded. Default: 256 MB. */
  readonly maxHeapMb?: number;
}

/**
 * Default resource limits — exported for tests and host wiring.
 * @public
 */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  phaseTimeoutMs: 60_000,
  maxStepsPerCycle: 200,
  maxHeapMb: 256,
};

/**
 * Full configuration for an OODA agent. Type parameters chain phase
 * input/output to enforce compile-time data flow correctness.
 * @public
 */
export interface OODAAgentConfig<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
> {
  readonly agentId: string;
  /** Agent version string for OTel spans. Defaults to "0.0.0" if omitted. */
  readonly agentVersion?: string;
  /** Cycle interval (ms). Sequential `while+sleep` loop. */
  readonly intervalMs: number;
  /** REQUIRED. Anti-pattern #6 — no implicit default. */
  readonly executionMode: ExecutionMode;
  readonly config?: TConfig;
  /**
   * Optional hot-reload config loader. When provided, each cycle refreshes
   * `ctx.config` by calling `configLoader.get(agentId)` before phase
   * execution. Static `config` above serves as the initial/fallback value.
   */
  readonly configLoader?: AgentConfigLoader<TConfig>;
  readonly db: DbClient;
  readonly logger: LoggerPort;
  readonly skills?: SkillRegistry;

  /**
   * Port dependencies injected at boot (BYOM — plan v6 §3.7).
   *
   * Required since SDK 1.0. Boot validation throws `MissingDependencyError`
   * if this field is absent or `deps.llm` is missing.
   */
  readonly deps: OODAAgentDeps;

  readonly phases: {
    readonly observe: PhaseDef<void, TObs>;
    readonly orient: PhaseDef<TObs, TOrient>;
    readonly decide: PhaseDef<TOrient, TDecision>;
    readonly act: PhaseDef<TDecision, TAction>;
    /**
     * Optional 6th phase — self-critique between act and feedback.
     *
     * Receives `{ action, decision }` and produces a self-critique.
     * Rule-based agents skip this phase. When omitted, the OODA loop
     * moves directly from act to feedback with no reflection.
     */
    readonly reflect?: PhaseDef<TAction & { decision: TDecision }, TFeedback>;
    readonly feedback: PhaseDef<TAction, TFeedback>;
  };

  readonly sessionGuards?: readonly SessionGuard[];
  readonly riskGuards?: readonly RiskGuard[];
  readonly outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
  readonly resourceLimits?: ResourceLimits;

  /** Side-effecting helpers injected by host. */
  readonly insertStepImpl?: OODAContext["insertStep"];
  readonly completeStepImpl?: OODAContext["completeStep"];
  readonly errorStepImpl?: OODAContext["errorStep"];
  readonly notifySlackImpl?: OODAContext["notifySlack"];

  /**
   * Optional telemetry sink (or a {@link createTelemetryBus} for multi-sink).
   *
   * Per ADR-ECO-039. Receives one `start`, 0..N `step`, and one `finish` event
   * per OODA cycle. Failures are isolated by the bus — never block the agent.
   * When absent, telemetry is silently skipped.
   *
   * @experimental — public-experimental contract (interface stable as of 1.3.0,
   * additional event fields may be added before 2.0).
   */
  readonly telemetry?: import("../../telemetry/port.js").TelemetrySink;

  /**
   * Optional HITL gate awaiter. Called when `act` phase has
   * `hitlGate: true`. Resolves when human approves; rejects to abort.
   */
  readonly waitForHITL?: (ctx: {
    runId: string;
    stepId: string;
    payload: unknown;
  }) => Promise<void>;

  /**
   * Optional skill capture loop — Hermes Skill Store equivalent.
   * Triggered post-feedback when outcome quality crosses threshold.
   * @public @experimental @since 1.13.0
   * Ref: sprint-727:skill-capture
   */
  readonly skillCapture?: import("./skill-capture.js").SkillCaptureOptions;

  /**
   * Optional hook invoked after each phase completes (observe, orient,
   * decide, act, [reflect], feedback). Receives a {@link StepEvent} with
   * phase name, duration, and optionally tokens/cost/model (when easily
   * available downstream of an LLM call). Use for TUI status bars, live
   * observability, external metrics, etc.
   *
   * Fail-soft: errors thrown by `onStep` are caught + logged but do NOT
   * abort the cycle. Async callbacks are awaited.
   *
   * @public @experimental @since 1.13.0
   * Ref: sprint-727:stream-capture-onstep
   */
  readonly onStep?: (event: StepEvent) => void | Promise<void>;

  /**
   * Optional TSA timestamping configuration (A4 — sprint-561).
   *
   * When `when` is `'on-cycle-complete'`, the agent calls `port.request(rootHash)`
   * after each successful cycle. On TSA failure, a `timestamp_pending` event is
   * emitted and — if `queue` is configured — the entry is added to the queue for
   * later retry.
   *
   * When `when` is `'disabled'` (default when absent), no timestamping occurs
   * and no existing cycle behavior changes.
   *
   * NOTE: `rootHash` must be provided externally (via A-DEMO consolidation of
   * the Trace). Until A-DEMO wires the Trace builder, this is a no-op silently
   * when `rootHash` is undefined — the config is accepted at construction but
   * the port is not called.
   */
  readonly timestamping?: {
    /** TimestampPort adapter (e.g. FreeTSAAdapter or NullTimestampPort). */
    readonly port: TimestampPort;
    /** Optional receipt queue for retry on failure. */
    readonly queue?: ReceiptQueue;
    /** KeyProvider for queue HMAC (required when queue is set). */
    readonly queueHmacKeyProvider?: KeyProvider;
    /** Key identifier for queueHmacKeyProvider (required when queue is set). */
    readonly queueHmacKeyId?: string;
    /**
     * Trigger mode.
     * - `'on-cycle-complete'`: timestamp after each successful cycle.
     * - `'on-demand'`: caller manages invocation (not yet implemented).
     * - `'disabled'`: no-op (default when `timestamping` is absent).
     */
    readonly when: "on-cycle-complete" | "on-demand" | "disabled";
  };
}

/**
 * OODAAgent — public handle returned by `createOODAAgent`.
 * @public
 */
export interface OODAAgent {
  /** Begin sequential cycle loop. Resolves once `stop()` is called. */
  start(): Promise<void>;
  /** Signal the loop to exit after the current cycle finishes. */
  stop(): Promise<void>;
  /**
   * One-shot cycle. `dryRun` flag is REQUIRED (audit-ready contract).
   * Throws `MissingDryRunFlagError` if `opts.dryRun` is `undefined` or `opts` is omitted.
   *
   * `initialContext` injects initial observation/context for event-driven
   * activation — enables agents to react to external events without a
   * full observe phase.
   */
  triggerCycle(opts: {
    dryRun: boolean;
    initialContext?: Record<string, unknown>;
  }): Promise<{ runId: string; status: CycleStatus }>;
  /**
   * Execute one cycle and stream `CycleEvent` events as they occur.
   * `dryRun: true` overrides `executionMode` to `dry-run`.
   *
   * @public @experimental
   */
  streamCycle(opts: {
    dryRun: boolean;
    initialContext?: Record<string, unknown>;
  }): AsyncIterable<CycleEvent>;
  getStatus(): {
    running: boolean;
    lastCycleAt?: string;
    nextCycleAt?: string;
    cyclesCompleted: number;
  };
}

/**
 * Terminal cycle outcomes. `skipped` = guard tripped, no work done.
 * @public
 */
export type CycleStatus = "succeeded" | "failed" | "skipped";

// ─── Typed streaming events (A1 — sprint-561) ────────────────────────────────

/**
 * CycleEventV010 — 10 variants emitted by `streamCycle()`.
 *
 * All variants are discriminated by `type`. The `timestamp_pending` variant
 * is typed here but NOT emitted by `streamCycle()` — it is reserved for A4
 * (proof timestamping pipeline).
 *
 * @public @experimental
 */
export type CycleEventV010 =
  | {
      type: "phase_start";
      runId: string;
      cycleIndex: number;
      phase: string;
      ts: number;
    }
  | {
      type: "phase_complete";
      runId: string;
      cycleIndex: number;
      phase: string;
      durationMs: number;
      ts: number;
    }
  | {
      type: "phase_error";
      runId: string;
      cycleIndex: number;
      phase: string;
      error: { message: string };
      ts: number;
    }
  | {
      type: "guard_tripped";
      runId: string;
      cycleIndex: number;
      guard: string;
      reason: string;
      ts: number;
    }
  | {
      type: "hitl_waiting";
      runId: string;
      cycleIndex: number;
      stepId: string;
      payloadHash: string;
      ts: number;
    }
  | {
      type: "hitl_approved";
      runId: string;
      cycleIndex: number;
      stepId: string;
      ts: number;
    }
  | {
      type: "cycle_complete";
      runId: string;
      cycleIndex: number;
      status: CycleStatus;
      durationMs: number;
      ts: number;
    }
  | {
      type: "cycle_skipped";
      runId: string;
      cycleIndex: number;
      reason: string;
      ts: number;
    }
  | {
      type: "cycle_error";
      runId: string;
      cycleIndex: number;
      error: { message: string };
      ts: number;
    }
  | {
      type: "timestamp_pending";
      runId: string;
      cycleIndex: number;
      rootHash: string;
      ts: number;
    };

/**
 * CycleEventV011 — 3 variants typed for B1 (handoff/guardrail/cycle_proven).
 * Typed but NOT emitted yet — reserved for sprint-562 B1.
 *
 * @public @experimental
 */
export type CycleEventV011 =
  | {
      type: "guardrail_violated";
      runId: string;
      cycleIndex: number;
      phase: string;
      timing: "pre-phase" | "post-phase";
      proofHash: string;
      reason: string;
      ts: number;
    }
  | {
      type: "handoff_initiated";
      runId: string;
      cycleIndex: number;
      targetAgentId: string;
      childRunId: string;
      handoffChain: string[];
      ts: number;
    }
  | {
      type: "cycle_proven";
      runId: string;
      cycleIndex: number;
      rootHash: string;
      entriesCount: number;
      proofChainRef: string;
      ts: number;
    };

/**
 * CycleEvent — full discriminated union (V010 | V011).
 *
 * @public @experimental
 */
export type CycleEvent = CycleEventV010 | CycleEventV011;

/**
 * StepEvent — emitted via {@link OODAAgentConfig.onStep} after each OODA
 * phase completes successfully (observe, orient, decide, act, reflect,
 * feedback). Designed as a TUI-friendly turn-by-turn signal.
 *
 * Stability: `@public-experimental`. Field shape is stable as of 1.13.0 ;
 * additional optional fields may be added before 2.0. Errors thrown by
 * the consumer never abort the cycle.
 *
 * @public @experimental @since 1.13.0
 */
export interface StepEvent {
  /** Cycle index (0-based). */
  readonly cycleIndex: number;
  /** Phase that just completed. */
  readonly phase: OODAPhaseKind;
  /** Milliseconds spent in this phase (wall-clock). */
  readonly durationMs: number;
  /** Optional cycle event ID (tied to telemetry/trace). */
  readonly cycleEventId?: string;
  /** Optional token counts from this phase (if a `complete` call happened). */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Optional cost USD for this phase (if LLM call). */
  readonly costUsd?: number;
  /** Optional model identifier used (if LLM call). */
  readonly model?: string;
  /** Run ID for cross-correlation. */
  readonly runId: string;
}
