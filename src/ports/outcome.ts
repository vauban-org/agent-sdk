/**
 * OutcomePort — post-run outcome instrumentation.
 *
 * Host attributes a monetary value to each agent run via its
 * domain-specific rules (config/outcomes.yaml in CC). The agent simply
 * calls recordOutcomeAsync after its tracker.finish() — fire-and-forget.
 */

export interface AgentRunRef {
  /** agent_run.id (UUID) produced by AgentRunTracker. */
  id: string;
  /** Logical agent identity, matches AgentDescriptor.id. */
  agent_id: string;
  /** Hash / caller-generated run id for trace correlation. */
  run_id?: string;
  /** Already-linked outcome id; idempotency guard. */
  outcome_id?: string | null;
}

export interface OutcomePort {
  /**
   * Enqueue outcome attribution. Fire-and-forget: never throws,
   * never blocks the agent lifecycle. Errors are logged by the impl.
   */
  recordOutcomeAsync(run: AgentRunRef): void;
}
