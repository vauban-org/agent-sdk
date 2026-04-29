/**
 * Skill Ledger — types + resolver for persisted winning strategies.
 *
 * SkillLedgerEntry mirrors the `skill_ledger` DB schema (migration 028).
 * resolveSkillsForAgent implements LIFO scope-typed resolution:
 *   1. Match by agent_id (exact) OR agent_id='*' (cross-agent wildcard)
 *   2. Match outcome_type
 *   3. lifecycle_state === 'active'
 *   4. Sort descending by created_at (LIFO — most recent wins)
 *
 * @public
 * Ref: command-center:sprint-530:quick-4
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillLifecycleState = "active" | "archived" | "deprecated";

export interface SkillLedgerEntry {
  /** UUID primary key */
  id: string;
  /** Human-readable skill name (e.g. "kelly_cap_0.12_conviction_gt_0.8") */
  skill_name: string;
  /** SHA-256 of the skill payload — deduplication key */
  skill_sha256: string;
  /** Run IDs from which this skill was extracted */
  source_run_ids: string[];
  /**
   * Agent that owns this skill.
   * '*' means promoted cross-agent (available to all agents with matching outcome_type).
   */
  agent_id: string;
  /** Outcome type this skill applies to (e.g. "trade_signal", "risk_report") */
  outcome_type: string;
  /** Brain entry ID where the skill rationale is archived */
  brain_entry_id: string;
  /** Arbitrary performance / quality metrics */
  metrics: Record<string, unknown>;
  lifecycle_state: SkillLifecycleState;
  created_at: string; // ISO-8601
}

// ─── Resolver options ─────────────────────────────────────────────────────────

export interface ResolveSkillsOptions {
  /** Agent ID to resolve for (exact match OR '*' wildcard entries). */
  agentId: string;
  /** Outcome type filter (exact match). */
  outcomeType: string;
  /**
   * Maximum number of skills to return.
   * Defaults to all matching entries (LIFO ordered).
   */
  limit?: number;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve skills for a given agent + outcome type.
 *
 * LIFO scope-typed algorithm:
 *   - Include entries where `agent_id === agentId` OR `agent_id === '*'`
 *   - Include entries where `outcome_type === outcomeType`
 *   - Include entries where `lifecycle_state === 'active'`
 *   - Sort descending by `created_at` (most recent first)
 *   - Apply optional `limit`
 *
 * Pure function — no side effects.
 */
export function resolveSkillsForAgent(
  skills: readonly SkillLedgerEntry[],
  opts: ResolveSkillsOptions,
): SkillLedgerEntry[] {
  const { agentId, outcomeType, limit } = opts;

  const filtered = skills.filter(
    (s) =>
      (s.agent_id === agentId || s.agent_id === "*") &&
      s.outcome_type === outcomeType &&
      s.lifecycle_state === "active",
  );

  // LIFO: most recent created_at first
  filtered.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return tb - ta;
  });

  return limit !== undefined ? filtered.slice(0, limit) : filtered;
}
