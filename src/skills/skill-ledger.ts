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

/**
 * Per-skill runtime metadata (Beyond-Hermes Wave 2). Typed extension of the
 * formerly-untyped metrics bag ; every field is optional and an open index
 * signature is kept, so existing rows and construction sites stay valid
 * (non-breaking). `pinned` + `mutationSource` drive the Wave-3 auto-overwrite
 * guard (canAutoOverwrite).
 * @public
 */
export interface SkillMetrics {
  /** Times this skill was applied at runtime. */
  execution_count?: number;
  /** Running mean of successful applications, in [0,1]. */
  success_rate?: number;
  /** ISO-8601 timestamp of the last write-time verification pass. */
  last_verified?: string;
  /** Write-time battery composite score, in [0,1]. */
  consistency_score?: number;
  /** Model id that synthesized the skill (provenance). */
  creator_model?: string;
  /** Manually pinned: protected from auto-improvement overwrite. */
  pinned?: boolean;
  /** Whether the latest mutation was a human edit or an auto-improvement. */
  mutationSource?: "manual" | "auto";
  /** Open extension ; preserves the prior Record<string, unknown> shape. */
  [key: string]: unknown;
}

/** @public */
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
  /** Typed performance / quality metrics (open-ended ; see SkillMetrics). */
  metrics: SkillMetrics;
  lifecycle_state: SkillLifecycleState;
  created_at: string; // ISO-8601
}

// ─── Resolver options ─────────────────────────────────────────────────────────

/** @public */
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
 * @public
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

// ─── Overwrite guard (Beyond-Hermes W3-T1) ─────────────────────────────────────

/**
 * May an auto-improvement overwrite an existing skill?
 *
 * Returns `false` (protected) when the existing skill is pinned OR its last
 * mutation was a human edit (`mutationSource === "manual"`). An auto-improve
 * cycle must never clobber a curated or hand-edited skill ; that is the Hermes
 * self-improvement failure mode (Secure-Agent-Skills, arXiv:2604.02837). Returns
 * `true` otherwise, so a genuine improvement of an unprotected, auto-authored
 * skill proceeds. A missing/empty metrics bag is treated as unprotected.
 *
 * Pure ; the predicate only. Callers (the governed skill-capture overwrite-guard,
 * `preste skills rollback`) supply the EXISTING skill's metrics. The incoming
 * candidate does not affect protection ; pinning is a property of what is
 * already on disk, not of the replacement.
 * @public
 */
export function canAutoOverwrite(existing: SkillMetrics | null | undefined): boolean {
  if (!existing) return true;
  if (existing.pinned === true) return false;
  if (existing.mutationSource === "manual") return false;
  return true;
}
