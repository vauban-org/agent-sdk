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

import type { DbClient } from "../../tracking/agent-run-tracker.js";
import type { LoggerPort } from "../../ports/logger.js";
import type { SkillRegistry } from "./skills.js";
import type { AgentConfigLoader } from "./agent-config-loader.js";

/**
 * The five OODA phase kinds. Mirrors the four `RunStep.type` values in
 * `proof/types.ts` plus the `observation` legacy variant — kept aligned so
 * step rows persisted through `OODAContext.insertStep` flow cleanly into
 * the proof certificate pipeline.
 */
export type OODAPhaseKind =
  | "retrieval"
  | "decision"
  | "execution"
  | "feedback"
  | "observation";

/**
 * Execution mode — REQUIRED at construction. Anti-pattern #6: no default.
 *
 * - `dry-run`: phases run, skills consult `dryRunMocks`, no production
 *   side-effects (no Brain writes, no on-chain tx, no Slack live).
 * - `live`: full production execution.
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
}

/**
 * PhaseDef — pure(ish) function from `TInput` to `TOutput` plus metadata.
 *
 * Constructor enforces `readOnly: true` on `observe` and `orient` phases.
 * The `hitlGate` flag is only meaningful on `act`; ignored elsewhere.
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
 */
export interface RiskGuard {
  readonly name: string;
  check(ctx: OODAContext): Promise<{ proceed: boolean; reason?: string }>;
}

/**
 * OutcomeRecord — optional output of `outcomeMapping(feedback)`. Persisted
 * as an outcome row attributable to this run.
 */
export interface OutcomeRecord {
  readonly outcome_type: string;
  readonly value_cents: number;
  readonly is_pending_backfill?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Resource limits — anti-pattern #9 + #10. Defaults applied when omitted.
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
 */
export const DEFAULT_RESOURCE_LIMITS: Required<ResourceLimits> = {
  phaseTimeoutMs: 60_000,
  maxStepsPerCycle: 200,
  maxHeapMb: 256,
};

/**
 * Full configuration for an OODA agent. Type parameters chain phase
 * input/output to enforce compile-time data flow correctness.
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

  readonly phases: {
    readonly observe: PhaseDef<void, TObs>;
    readonly orient: PhaseDef<TObs, TOrient>;
    readonly decide: PhaseDef<TOrient, TDecision>;
    readonly act: PhaseDef<TDecision, TAction>;
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
   * Optional HITL gate awaiter. Called when `act` phase has
   * `hitlGate: true`. Resolves when human approves; rejects to abort.
   */
  readonly waitForHITL?: (ctx: {
    runId: string;
    stepId: string;
    payload: unknown;
  }) => Promise<void>;
}

/**
 * OODAAgent — public handle returned by `createOODAAgent`.
 */
export interface OODAAgent {
  /** Begin sequential cycle loop. Resolves once `stop()` is called. */
  start(): Promise<void>;
  /** Signal the loop to exit after the current cycle finishes. */
  stop(): Promise<void>;
  /** One-shot cycle. `dryRun: true` overrides `executionMode` to `dry-run`. */
  triggerCycle(opts?: {
    dryRun?: boolean;
  }): Promise<{ runId: string; status: CycleStatus }>;
  getStatus(): {
    running: boolean;
    lastCycleAt?: string;
    nextCycleAt?: string;
    cyclesCompleted: number;
  };
}

/**
 * Terminal cycle outcomes. `skipped` = guard tripped, no work done.
 */
export type CycleStatus = "succeeded" | "failed" | "skipped";
