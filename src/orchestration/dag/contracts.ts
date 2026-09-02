/**
 * SOTA orchestration engine — shared port contracts (v1: caps 1+2+3).
 *
 * These are PURE interfaces (zero runtime). They are the decoupling seam:
 * the DAG scheduler depends ONLY on these ports, never on a concrete executor,
 * verifier, or journal. preste (or any consumer) injects the implementations.
 * The engine therefore never imports `packages/cli` (preste) or infra.
 *
 * See docs/superpowers/specs/2026-06-05-sota-orchestration-engine-design.md.
 * Builds on ADR-ECO-068 (verifier battery), ADR-ECO-076 (governed delegation),
 * ADR-ECO-083 (GovernedWorkflow + WorkflowRuntimePort).
 *
 * @since agent-sdk SOTA-orchestration v1
 */

import type { ClockPort } from "../../replay/clock.js";

/** Terminal state of a single node. Lowercase, parent-facing vocabulary. */
export type NodeStatus = "done" | "deferred" | "failed";

/**
 * One node in the orchestration DAG. A node is a unit of delegated work.
 *
 * - `dependsOn` makes the node consume upstream node outputs (the scheduler
 *   passes them in `NodeInputs`). Empty/absent = a root node (runs immediately).
 * - `mapOver` (Send-API style) dynamically fans this node into one child per
 *   element of the named upstream node's array output (dynamic fan-out).
 * - `samples` (>1) requests best-of-N: run N attempts, keep the verified-best
 *   (Cap 1). Requires a Verifier on the run. Default 1 (no best-of-N).
 * - `runIf` is a conditional edge: skip the node (status "deferred", reason
 *   "skipped") when the predicate over upstream inputs is false.
 * - `grant` is the capability attenuation spec forwarded to delegate()
 *   (ADR-076); the child surface is a strict subset of the parent's.
 * - `model` is a per-node execution hint passed through OPAQUELY to the
 *   executor (same category as `grant`). The scheduler NEVER interprets it
 *   (model-agnostic invariant preserved); it is purely an executor concern,
 *   handed to the executor via the full DagNodeSpec.
 */
export interface DagNodeSpec {
  readonly id: string;
  readonly task: string;
  readonly dependsOn?: readonly string[];
  readonly mapOver?: string;
  readonly samples?: number;
  readonly timeoutMs?: number;
  /** Capability attenuation (shape mirrors delegation grant; kept structural to avoid a hard dep). */
  readonly grant?: {
    readonly tools?: readonly string[];
    readonly maxSteps?: number;
  };
  /**
   * Per-node model execution hint (e.g. "deepseek-v4-flash" / "deepseek-v4-pro").
   * Opaque to the engine: the scheduler does not interpret it and stays
   * model-agnostic. The executor reads it off the DagNodeSpec.
   */
  readonly model?: string;
  readonly runIf?: (inputs: NodeInputs) => boolean;
  /**
   * Cap 4 — bounded transient retry. Max times this node is automatically
   * re-run after ending `deferred` due to its OWN scheduler-armed timeout
   * (NOT upstream-not-done, NOT runIf-skip, NOT top-level cancel). When unset,
   * `DagRunInput.defaultMaxTimeoutRetries` applies; if neither is set the
   * default is 0 (no retry — byte-identical to pre-Cap-4 behaviour).
   */
  readonly maxTimeoutRetries?: number;
}

/** Resolved outputs of a node's upstream dependencies, keyed by node id. */
export type NodeInputs = Readonly<Record<string, unknown>>;

/** Result of executing one node attempt. */
export interface NodeOutcome<TOutput = unknown> {
  readonly status: NodeStatus;
  /** Output when status is "done"; null otherwise. */
  readonly output: TOutput | null;
  /** Failure/timeout/skip reason when status is not "done". */
  readonly reason?: string;
}

/**
 * Port: executes ONE node attempt. The ONLY coupling to the agent runtime.
 * preste supplies a concrete executor wrapping spawnChildAgent + delegate().
 * The engine treats it as a black box and is unit-testable with a fake.
 *
 * `attempt` is the 0-based sample index (for best-of-N); executors may vary
 * sampling temperature by index but MUST remain otherwise deterministic for a
 * given (node, inputs, attempt) so replay holds.
 */
export type NodeExecutor<TOutput = unknown> = (
  node: DagNodeSpec,
  inputs: NodeInputs,
  ctx: { readonly attempt: number; readonly signal?: AbortSignal },
) => Promise<NodeOutcome<TOutput>>;

/** A verifier's verdict over a set of candidate outputs (Cap 1). */
export interface VerifierVerdict<TOutput = unknown> {
  /** The accepted best candidate; null = all rejected (fail-closed). */
  readonly accepted: TOutput | null;
  /** Index of the accepted candidate in the input array; -1 when none. */
  readonly acceptedIndex: number;
  /** Human-readable rationale (Art.12/14 evidence; no plaintext secrets). */
  readonly reason: string;
  /**
   * Composite [0,1] score of the accepted candidate, when the verifier exposes
   * one (the battery does). Absent for verifiers that do not score. Read by the
   * adaptive best-of-N escalation to decide whether a cheap initial batch already
   * produced a confident-enough winner (the early-accept / ST-BoN gate).
   */
  readonly acceptedScore?: number;
}

/**
 * Port: ranks N candidate outputs and returns the verified-best, fail-closed.
 * The default implementation wraps runVerifierBattery (ADR-068, with its
 * mandatory deterministic non-llm-judge anchor). Kept as a minimal port so the
 * DAG engine does not hard-depend on the battery module — decoupling.
 */
export type Verifier<TOutput = unknown> = (
  candidates: readonly TOutput[],
  ctx: { readonly node: DagNodeSpec; readonly inputs: NodeInputs },
) => Promise<VerifierVerdict<TOutput>>;

/**
 * Port: adaptive re-planner (Cap 4, the Magentic-One seam). Invoked when a node
 * ends TERMINALLY `failed` (after any Part-A timeout retries) and a global
 * replan budget remains. It MAY return a replacement sub-DAG to splice into the
 * running graph, or `null` to leave the node failed (fail-closed: no replanner,
 * or a `null` return, reproduces exactly today's terminal-failure behaviour).
 *
 * Splice contract (the scheduler VALIDATES it; a violation is treated as
 * no-replan and the node stays failed, with the rejection reason surfaced):
 *  - The returned set MUST be non-empty and contain exactly one node whose
 *    `id === failed.id`. That node MUST be LAST in the array. Reusing the failed
 *    id lets the failed node's existing dependents resolve against the same id
 *    (the spliced graph transparently replaces the failed work).
 *  - The earlier returned nodes (if any) use FRESH ids that do not collide with
 *    any existing non-failed node; the last node typically `dependsOn` them
 *    (the final synthesis over the re-decomposed sub-tasks).
 *  - The spliced set MUST NOT introduce an id collision with an existing
 *    NON-failed node, and MUST NOT create a cycle in the combined graph.
 *
 * The SDK defines the port; a consumer (preste) injects an LLM-backed impl. The
 * engine treats it as a black box. Replanning is a RUNTIME concern: the spliced
 * nodes are NEVER folded into the pre-execution governance `rootHash` (same
 * stance Cap 5 took for cancellation — replay invariant, ADR-ECO-083 prop. 4).
 *
 * @public
 */
export type RePlanner<TOutput = unknown> = (ctx: {
  readonly failed: NodeManifestEntry<TOutput>;
  readonly spec: DagNodeSpec;
  readonly inputs: NodeInputs;
  readonly manifest: ReadonlyArray<NodeManifestEntry<TOutput>>;
}) => Promise<DagNodeSpec[] | null>;

/** Per-node entry in the run manifest (the orchestrator always knows state). */
export interface NodeManifestEntry<TOutput = unknown> {
  readonly id: string;
  readonly status: NodeStatus;
  readonly reason: string | null;
  readonly output: TOutput | null;
  readonly dependsOn: readonly string[];
  /** Number of attempts run (best-of-N); 1 when no sampling. */
  readonly attempts: number;
}

/** The orchestrator-facing result of a DAG run. Always this shape. */
export interface DagRunManifest<TOutput = unknown> {
  readonly workflowStatus: "DONE" | "FAILED";
  readonly summary: {
    readonly total: number;
    readonly done: number;
    readonly deferred: number;
    readonly failed: number;
  };
  readonly nodes: ReadonlyArray<NodeManifestEntry<TOutput>>;
  /** Pre-execution governance hash (ADR-083 four-properties); set by the engine. */
  readonly rootHash: string;
}

/**
 * Port: narrow node-level durability journal (Wave 2 — crash-resume).
 *
 * This is DELIBERATELY narrower than the full `WorkflowRuntimePort` (which
 * journals every step/now/random/uuid primitive): the DAG scheduler only needs
 * to recall and record a node's terminal outcome, so the port surface is just
 * two methods keyed by (runId, nodeId). A consumer (preste) supplies a concrete
 * sqlite-backed impl; the SDK never imports it (decoupling seam).
 *
 * Semantics enforced by the scheduler:
 *  - `recall` returning a `done` entry short-circuits execution (resume).
 *    Non-done (deferred/failed) recalled entries are IGNORED so a transient
 *    failure gets a fresh attempt on resume — done-only short-circuit.
 *  - `record` is called after a node reaches a terminal status and MUST be
 *    idempotent (recording the same (runId, nodeId) twice is safe — upsert).
 *  - Journal errors are SURFACED, not swallowed: a recall/record rejection
 *    propagates and fails the node (the run does not silently continue with a
 *    corrupt/missing journal).
 *  - Journal state is NEVER folded into the pre-execution `rootHash`
 *    (rootHash commits only to governance fields — determinism preserved).
 */
export interface StepJournal<TOutput = unknown> {
  /** Return a previously-recorded terminal outcome for this node, or undefined. */
  recall(
    runId: string,
    nodeId: string,
  ): Promise<NodeManifestEntry<TOutput> | undefined>;
  /** Persist a node's terminal outcome (done/deferred/failed) idempotently. */
  record(runId: string, entry: NodeManifestEntry<TOutput>): Promise<void>;
}

/**
 * Live per-node lifecycle event emitted by the scheduler as a DAG executes
 * (Cap 5). A discriminated union on `type`. Every variant carries the run id and
 * a clock timestamp (`at`, from `input.clock.now()`), so a consumer can build a
 * mid-flight timeline. Progress is a RUNTIME concern: it NEVER enters the
 * pre-execution governance `rootHash` (replay invariant, ADR-ECO-083 prop. 4).
 *
 * Variant guide:
 *  - `workflow_started`  — once, before any node runs; `nodeCount` = graph size.
 *  - `node_running`      — before each executor attempt; for best-of-N, emitted
 *                          per attempt (`attempt` 1-based, `samples` = total N;
 *                          a non-sampled node emits attempt=1 samples=1).
 *  - `node_verified`     — best-of-N only, after the verifier selection resolves;
 *                          `accepted` = a candidate was accepted (not fail-closed).
 *  - `node_resumed`      — journal done-short-circuit (resumed without executing).
 *  - `node_done`         — node reached terminal `done`.
 *  - `node_failed`       — node reached terminal `failed` (`reason`).
 *  - `node_deferred`     — node reached terminal `deferred` (`reason`; covers
 *                          upstream-not-done, runIf skip, timeout, and cancel).
 *  - `node_replanned`    — Cap 4: a terminally-failed node was re-decomposed by
 *                          the re-planner; `childCount` spliced nodes added.
 *  - `workflow_settled`  — once, after execution; final status + summary counts.
 *
 * @public
 */
export type WorkflowProgressEvent<TOutput = unknown> =
  | {
      readonly type: "workflow_started";
      readonly runId: string;
      readonly nodeCount: number;
      readonly at: number;
    }
  | {
      readonly type: "node_ready";
      readonly runId: string;
      readonly nodeId: string;
      readonly at: number;
    }
  | {
      readonly type: "node_running";
      readonly runId: string;
      readonly nodeId: string;
      readonly attempt: number;
      readonly samples: number;
      readonly at: number;
    }
  | {
      readonly type: "node_verified";
      readonly runId: string;
      readonly nodeId: string;
      readonly accepted: boolean;
      readonly at: number;
    }
  | {
      readonly type: "node_resumed";
      readonly runId: string;
      readonly nodeId: string;
      readonly at: number;
    }
  | {
      readonly type: "node_done";
      readonly runId: string;
      readonly nodeId: string;
      /**
       * The node's settled output, when available at emit time (best-effort).
       * Optional so the variant stays additive; consumers should not depend on
       * it being present (the authoritative output is always the manifest).
       */
      readonly output?: TOutput | null;
      readonly at: number;
    }
  | {
      readonly type: "node_failed";
      readonly runId: string;
      readonly nodeId: string;
      readonly reason: string;
      readonly at: number;
    }
  | {
      readonly type: "node_deferred";
      readonly runId: string;
      readonly nodeId: string;
      readonly reason: string;
      readonly at: number;
    }
  | {
      readonly type: "node_replanned";
      readonly runId: string;
      /** Id of the terminally-failed node that was re-decomposed (reused id). */
      readonly nodeId: string;
      /** Number of spliced replacement nodes added to the run. */
      readonly childCount: number;
      readonly at: number;
    }
  | {
      readonly type: "workflow_settled";
      readonly runId: string;
      readonly status: "DONE" | "FAILED" | "CANCELLED";
      readonly total: number;
      readonly done: number;
      readonly deferred: number;
      readonly failed: number;
      readonly at: number;
    };
// `TOutput` is consumed by the `node_done` variant's optional `output` field;
// it stays generic so `WorkflowProgressSink` is type-aligned with the manifest.

/**
 * Port: a synchronous sink the scheduler pushes live progress events into
 * (Cap 5). The SDK defines the port; a consumer (preste) injects a concrete
 * sink (console + buffer, Telegram, OTEL span, …). The scheduler treats it as a
 * black box and is fail-soft: a sink that throws NEVER breaks the DAG run.
 *
 * @public
 */
export interface WorkflowProgressSink<TOutput = unknown> {
  emit(event: WorkflowProgressEvent<TOutput>): void;
}

/**
 * Adaptive best-of-N escalation policy (the "ST-BoN / adaptive-N" cap).
 *
 * Rationale (sourced): naive best-of-N is the weak baseline ; the win is spending
 * the sample budget ADAPTIVELY — a small cheap batch first, escalating to the full
 * `samples` budget ONLY when that batch did not already produce a confident winner
 * (Snell et al. 2408.03314 ; the diminishing-returns ceiling, 2411.17501, shows
 * the optimal N is "often finite and very low"). This is the side-effect-SAFE form
 * of "cancel the losing trajectories": the losers are never spawned, so there is
 * no mid-flight kill and no token-latent truncation (whose safety is unproven for
 * agent trajectories, 2503.01422). Literal mid-flight straggler-kill is the
 * deferred extension, gated on a per-node no-irreversible-side-effect declaration.
 *
 * When absent, best-of-N runs the full `samples` budget in one parallel batch
 * (byte-identical to the pre-adaptive scheduler).
 *
 * @public
 */
export interface AdaptiveBestOfNPolicy {
  /**
   * Size of the first parallel batch. The scheduler escalates to the node's full
   * `samples` only if this batch yields no winner at/above `earlyAcceptThreshold`.
   * Clamped to [1, samples]. Default: `ceil(samples / 2)` (min 2).
   */
  readonly initialBatch?: number;
  /**
   * Composite [0,1] bar a phase-1 survivor must clear to short-circuit (skip the
   * rest of the budget). Default 0.85. A verifier that does not expose
   * `acceptedScore` can never early-accept (the full budget always runs).
   */
  readonly earlyAcceptThreshold?: number;
}

/** Inputs to a DAG run. */
export interface DagRunInput<TOutput = unknown> {
  readonly nodes: readonly DagNodeSpec[];
  readonly executor: NodeExecutor<TOutput>;
  /** Required when any node sets samples > 1. */
  readonly verifier?: Verifier<TOutput>;
  readonly clock: ClockPort;
  /** Bound into the audit step; reuse the parent loop run id. */
  readonly runId: string;
  /** Governing decision record (ADR-068 traceability invariant). */
  readonly adrEco: string;
  /** Max concurrent node attempts. Default: unbounded (scheduler frontier). */
  readonly maxConcurrency?: number;
  /**
   * Optional node-level durability journal (Wave 2). When set, a crashed and
   * restarted run skips nodes already recorded `done` and resumes the rest.
   * When absent, behaviour is byte-identical to the in-memory scheduler.
   */
  readonly journal?: StepJournal<TOutput>;
  /**
   * Optional live progress sink (Cap 5). When set, the scheduler emits a
   * `WorkflowProgressEvent` at every node transition. When absent, every emit is
   * a no-op (byte-identical behaviour to a run without progress — additive
   * invariant). The sink is fail-soft: a throwing sink never breaks the run.
   */
  readonly progress?: WorkflowProgressSink<TOutput>;
  /**
   * Optional top-level mid-flight cancel signal (Cap 5). When this aborts, the
   * scheduler stops launching NEW pending nodes, marks all still-pending nodes
   * `deferred` (reason "cancelled"), and lets in-flight nodes settle. It is also
   * threaded into each per-node AbortController so in-flight executors that
   * honour `ctx.signal` can abort early. DISTINCT from the per-node executor
   * `ctx.signal` (which the scheduler derives from the per-node timeout AND this
   * signal combined).
   */
  readonly signal?: AbortSignal;
  /**
   * Cap 4 — global default for bounded transient (own-timeout) retry, used for
   * any node that does not set its own `maxTimeoutRetries`. Default 0 (no
   * retry — byte-identical to pre-Cap-4 behaviour). Negative values clamp to 0.
   */
  readonly defaultMaxTimeoutRetries?: number;
  /**
   * Cap 4 — adaptive re-planner (the Magentic-One seam). When set AND
   * `maxReplans` budget remains, a terminally-failed node is offered to the
   * re-planner, which may return a replacement sub-DAG to splice in. Absent =
   * fail-closed (terminal failure behaves exactly as today).
   */
  readonly replanner?: RePlanner<TOutput>;
  /**
   * Cap 4 — global replan budget (total replans across the whole run, not
   * per-node). Default 0 (re-planning OFF even if a `replanner` is supplied).
   * Each accepted replan decrements the budget by one. Negative clamps to 0.
   */
  readonly maxReplans?: number;
  /**
   * Adaptive best-of-N escalation policy. When set, a node with `samples > 1`
   * runs a cheap initial batch first and escalates to the full budget only if no
   * confident winner emerged. Absent = full `samples` in one parallel batch
   * (byte-identical to before). See {@link AdaptiveBestOfNPolicy}.
   */
  readonly bestOfN?: AdaptiveBestOfNPolicy;
}
