/**
 * ChildAgentPort — Supervisor-Worker pattern for multi-agent orchestration.
 *
 * Async-first design: `spawnAsync` returns a `workerId` immediately; the worker
 * publishes a `worker.completed` CloudEvent on the bus when done. The supervisor
 * picks it up in its next `observe()` cycle — never blocking.
 *
 * `spawnSync` is available for short tasks (< 10s) but should be used sparingly.
 *
 * Cycle detection: `maxChainDepth` (default 3) prevents infinite agent chains.
 * If `handoffChain.length >= maxChainDepth`, the port throws `HandoffCycleError`.
 *
 * @public
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ChildAgentOptions {
  /** Target agent identifier. */
  agentId: string;
  /** Task payload — arbitrary JSON-serializable record. */
  task: Record<string, unknown>;
  /** Max wait time for spawnSync (default: 10_000 ms). */
  timeoutMs?: number;
  /** Chain of agent IDs that have handed off to this worker. */
  handoffChain?: string[];
  /** Max chain depth before HandoffCycleError (default: 3). */
  maxChainDepth?: number;
}

/** @public */
export interface ChildAgentResult {
  workerId: string;
  status: "accepted" | "completed" | "failed" | "timeout";
  output?: unknown;
  error?: string;
}

// ─── Port ───────────────────────────────────────────────────────────────────────

/** @public */
export interface ChildAgentPort {
  /**
   * Fire-and-forget: spawn a worker, get workerId immediately.
   *
   * The worker publishes a `worker.completed` CloudEvent on the event bus
   * when done. The supervisor picks it up in its next observe() cycle.
   *
   * Throws `HandoffCycleError` if `handoffChain.length >= maxChainDepth`.
   */
  spawnAsync(opts: ChildAgentOptions): Promise<{ workerId: string }>;

  /**
   * Await result synchronously. Use only for short tasks (< 10s).
   *
   * Blocks the supervisor cycle during worker execution. Prefer `spawnAsync`
   * for all non-trivial work.
   *
   * Throws `HandoffCycleError` if `handoffChain.length >= maxChainDepth`.
   */
  spawnSync(opts: ChildAgentOptions): Promise<ChildAgentResult>;
}
