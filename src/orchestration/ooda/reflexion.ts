/**
 * Reflexion Memory — Brain-stored lessons for future cycles.
 *
 * Safety constraints (non-negotiable):
 *   - confidence MUST be > 0.6 for retrieval (prevents low-quality lessons from
 *     poisoning future decisions).
 *   - TTL defaults to 30 days (stale lessons expire).
 *   - Every entry carries `sourceCycleId` and `outcomeType` for traceability.
 *   - Brain stores with category="forge_reflexion", tags=["reflexion", "agent:<id>"].
 *
 * A single incorrect reflection persisting in a long-running agent is
 * catastrophic — severity scales with agent lifetime. Confidence weighting
 * + TTL guard against reflexion poisoning.
 *
 * @public
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ReflexionEntry {
  /** The lesson learned. */
  content: string;
  /** Confidence score (0.0 - 1.0). MUST be provided. */
  confidence: number;
  /** The cycle that generated this lesson. */
  sourceCycleId: string;
  /** What happened: "succeeded" | "failed" | "partial". */
  outcomeType: "succeeded" | "failed" | "partial";
  /** Time-to-live in milliseconds (default: 30 days). */
  ttlMs?: number;
}

/** @public */
export interface ReflexionQuery {
  agentId: string;
  /** Only match entries for this outcome type. */
  outcomeType?: "succeeded" | "failed" | "partial";
  /** Max entries to return (default: 5). */
  limit?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE = 0.6;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Store / Query ──────────────────────────────────────────────────────────────

/**
 * Store a reflexion entry via a BrainPort-compatible archival function.
 *
 * The `archiver` is typically `brain.archiveKnowledge()` or
 * `semantic.archive()`.
 * @public
 */
export async function storeReflexion(
  entry: ReflexionEntry,
  agentId: string,
  archiver: (input: {
    content: string;
    category?: string;
    tags?: string[];
    confidence?: number;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>,
): Promise<void> {
  await archiver({
    content: entry.content,
    category: "forge_reflexion",
    tags: ["reflexion", `agent:${agentId}`],
    confidence: entry.confidence,
    metadata: {
      sourceCycleId: entry.sourceCycleId,
      outcomeType: entry.outcomeType,
      ttlMs: entry.ttlMs ?? DEFAULT_TTL_MS,
    },
  });
}

/**
 * Query reflexion memory.
 *
 * ONLY returns entries with confidence > 0.6 AND within TTL window.
 * The `querier` is typically `brain.queryKnowledge()` or `semantic.query()`.
 * @public
 */
export async function queryReflexionMemory(
  query: ReflexionQuery,
  querier: (q: string, filters?: Record<string, unknown>) => Promise<ReflexionEntry[]>,
): Promise<ReflexionEntry[]> {
  const results = await querier(`reflexion ${query.agentId} ${query.outcomeType ?? ""}`, {
    category: "forge_reflexion",
    tags: ["reflexion", `agent:${query.agentId}`],
    limit: query.limit ?? 5,
  });

  return results
    .filter((entry) => {
      if (entry.confidence < MIN_CONFIDENCE) return false;
      return true;
    })
    .slice(0, query.limit ?? 5);
}
