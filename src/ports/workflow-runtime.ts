/**
 * WorkflowRuntimePort — durable workflow execution port (S3 spec).
 *
 * Defines: 9-state machine, journal invariants I-S3-1..8, replay determinism,
 * ctx.* primitives, lease takeover pattern, handler versioning.
 *
 * Default adapter: DBOSWorkflowAdapter (DBOS-TS Apache 2.0, Postgres-native).
 * Swap-able to Temporal/Restate via this port + test contract T-S3-1..12.
 * @public
 */

// ─── Workflow run state machine (S3 §3.1) ─────────────────────────────────────

export type WorkflowStatus =
  | "PENDING"
  | "RUNNING"
  | "SLEEPING"
  | "WAITING_SIGNAL"
  | "AWAITING_BLOCK"
  | "AWAITING_EVENT"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

// ─── Journal types (S3 §4) ────────────────────────────────────────────────────

/** @public */
export type StepKind =
  | "tool_call"
  | "sleep"
  | "wait_signal"
  | "await_block"
  | "await_event"
  | "submit_tx"
  | "human"
  | "ctx_now"
  | "ctx_random"
  | "ctx_uuid"
  | "child_workflow";

/** @public */
export type StepStatus = "pending" | "running" | "done" | "failed";

/** @public */
export interface JournalEntry {
  readonly journal_id: bigint;
  readonly run_id: string; // UUID
  readonly step_index: number; // monotone, I-S3-1
  readonly step_name: string;
  readonly step_kind: StepKind;
  readonly status: StepStatus;
  readonly input: unknown; // CBOR-encoded at rest
  readonly output?: unknown;
  readonly error?: { message: string; stack?: string };
  readonly idempotency_key?: string; // 32-byte hex, I-S3-3
  readonly started_at: Date;
  readonly finished_at?: Date;
}

// ─── Workflow run (S3 §3.1 + §7) ─────────────────────────────────────────────

/** @public */
export interface WorkflowRun<TOutput = unknown> {
  readonly run_id: string;
  readonly workflow_name: string;
  readonly workflow_version: string; // locked per I-S3-6
  readonly status: WorkflowStatus;
  readonly input: unknown;
  readonly output?: TOutput;
  readonly error?: string;
  readonly lease_owner?: string;
  readonly lease_expires_at?: Date;
  readonly wake_at?: Date;
  readonly started_at: Date;
  readonly finished_at?: Date;
  readonly tenant_id: string;
  readonly manifest_hash?: string; // crosslink S1
}

// ─── Step options ─────────────────────────────────────────────────────────────

/** @public */
export interface StepOpts {
  readonly maxAttempts?: number; // default 3, EC-S3-6
  readonly backoffMs?: number; // default 1000 (1s/2s/4s)
  readonly idempotencyKey?: string;
  readonly timeoutMs?: number;
}

// ─── WorkflowContext — ctx.* primitives (S3 §5.3) ────────────────────────────

/** @public */
export interface WorkflowContext {
  readonly runId: string;
  readonly tenantId: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly abortSignal: AbortSignal;

  /**
   * Wrap any side-effectful operation. Journaled + replayed from journal.
   * FORBIDDEN outside ctx.step(): Date.now, Math.random, fetch, fs.*, etc. (S3 §5.4)
   */
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOpts): Promise<T>;

  /** Deterministic timestamp — journaled (Q3.2). Never use Date.now() in handlers. */
  now(): Promise<Date>;

  /** Deterministic random [0,1) — journaled (Q3.2). Never use Math.random(). */
  random(): Promise<number>;

  /** Deterministic UUID v4 — journaled (Q3.2). Never use crypto.randomUUID(). */
  uuid(): Promise<string>;

  /** Durable sleep until absolute timestamp. EC-S3-8: t < now() → no-op. */
  sleepUntil(t: Date): Promise<void>;

  /** Durable sleep for duration in ms. */
  sleepFor(durationMs: number): Promise<void>;

  /**
   * Wait for a named signal. Returns signal payload.
   * Times out → WorkflowSignalTimeoutError (S3 §3.3: FAILED, 'signal_timeout').
   */
  waitForSignal<T = unknown>(name: string, timeoutMs?: number): Promise<T>;

  /** Await Starknet block height ≥ n. Transitions: RUNNING → AWAITING_BLOCK → RUNNING. */
  awaitStarknetBlock(blockHeight: number): Promise<void>;

  /** Await matching event from event bus. Transitions: RUNNING → AWAITING_EVENT → RUNNING. */
  awaitEvent<T = unknown>(filter: EventFilter): Promise<T>;

  /** Spawn a child workflow. Parent waits for child completion. */
  childWorkflow<TInput, TOutput>(
    name: string,
    input: TInput,
    opts?: ChildWorkflowOpts,
  ): Promise<TOutput>;

  /** Cooperative cancellation. Step handlers should poll ctx.abortSignal. */
  cancel(reason: string): Promise<void>;
}

/** @public */
export interface EventFilter {
  readonly source?: string;
  readonly type?: string;
  readonly tenantId?: string;
  readonly [key: string]: unknown;
}

/** @public */
export interface ChildWorkflowOpts {
  readonly tenantId?: string;
  readonly version?: string;
  readonly idempotencyKey?: string;
}

// ─── Handler type ─────────────────────────────────────────────────────────────

/** @public */
export type WorkflowHandler<TInput = unknown, TOutput = unknown> = (
  ctx: WorkflowContext,
  input: TInput,
) => Promise<TOutput>;

// ─── Migration (S3 §6.3) ──────────────────────────────────────────────────────

/** @public */
export type JournalMigrator = (journal: JournalEntry[]) => JournalEntry[];

/** @public */
export interface MigrationResult {
  readonly ok: boolean;
  readonly run_id: string;
  readonly from_version: string;
  readonly to_version: string;
  readonly entries_migrated: number;
  readonly error?: string;
}

// ─── WorkflowRuntimePort ──────────────────────────────────────────────────────

/** @public */
export interface StartWorkflowOpts {
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly tenantId: string;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly manifestHash?: string;
}

/** @public */
export interface ResumeWorkflowOpts {
  readonly workerId: string;
  readonly leaseTtlSeconds?: number; // default 60
}

/** @public */
export interface SendSignalOpts {
  readonly payload?: unknown;
}

/** @public */
export interface WorkflowRuntimePort {
  /**
   * Register a handler for a workflow name + version.
   * Must be called before start() for that workflow type.
   */
  register<TInput, TOutput>(
    name: string,
    version: string,
    handler: WorkflowHandler<TInput, TOutput>,
  ): void;

  /**
   * Start a new workflow run. Returns run_id.
   * Idempotent if idempotencyKey provided and run already exists.
   */
  start(opts: StartWorkflowOpts): Promise<string>;

  /**
   * Attempt to acquire lease and execute a pending/sleeping run.
   * Returns null if no eligible run found (no work to do).
   * Runs handler to completion (or suspension) before returning.
   */
  executeNext(opts: ResumeWorkflowOpts): Promise<WorkflowRun | null>;

  /** Get current state of a run. */
  getStatus(runId: string): Promise<WorkflowRun | null>;

  /**
   * Wait for a run to reach DONE or FAILED.
   * Polls internally — do not call in a tight loop.
   */
  waitForCompletion<TOutput>(
    runId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<WorkflowRun<TOutput>>;

  /** Send a named signal to a waiting run (S3 §3.3). */
  sendSignal(runId: string, signalName: string, opts?: SendSignalOpts): Promise<void>;

  /**
   * Cancel a run cooperatively (S3 §3.3, EC-S3-7).
   * Sets AbortSignal on next step boundary. Hard abort after 30s.
   */
  cancel(runId: string, reason: string): Promise<void>;

  /**
   * Migrate a suspended run to a new handler version (S3 §6.3).
   * Only valid for runs in SLEEPING | WAITING_SIGNAL | AWAITING_* states.
   */
  migrateRun(
    runId: string,
    fromVersion: string,
    toVersion: string,
    migrator: JournalMigrator,
  ): Promise<MigrationResult>;

  /** Read the journal entries for a run (read-only, audit). */
  getJournal(runId: string): Promise<JournalEntry[]>;

  /**
   * Start the worker polling loop.
   * Worker polls for PENDING runs and calls executeNext() in a loop.
   */
  startWorker(opts?: {
    workerId?: string;
    pollIntervalMs?: number;
    maxConcurrent?: number;
  }): Promise<void>;

  /** Stop the worker polling loop gracefully. */
  stopWorker(): Promise<void>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class WorkflowNotFoundError extends Error {
  constructor(public readonly runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "WorkflowNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class WorkflowNonDeterminismError extends Error {
  constructor(
    public readonly runId: string,
    public readonly stepIndex: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Non-determinism at step ${stepIndex}: expected ${expected}, got ${actual} (run=${runId})`,
    );
    this.name = "WorkflowNonDeterminismError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class WorkflowSignalTimeoutError extends Error {
  constructor(
    public readonly runId: string,
    public readonly signalName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Signal '${signalName}' timeout after ${timeoutMs}ms (run=${runId})`);
    this.name = "WorkflowSignalTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class WorkflowLeaseConflictError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentOwner: string,
  ) {
    super(`Cannot acquire lease for run ${runId}: held by ${currentOwner}`);
    this.name = "WorkflowLeaseConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class WorkflowVersionMismatchError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Version mismatch for run ${runId}: expected ${expected}, got ${actual}`);
    this.name = "WorkflowVersionMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
