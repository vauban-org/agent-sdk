/**
 * BrainRecallPort — memory-recall contract for the Agentic RAG pipeline.
 *
 * Promoted from apps/agents/forecaster/src/recall/ to SDK port per ADR-ECO-065
 * (sprint-805 Stage 2). L1 prototype evidence: docs/agentic-rag/L1-evidence-forecaster.md.
 *
 * BrainChunk COLLISION NOTE:
 *   The SDK already exports `BrainChunk` from orchestration/ooda/brain-context.ts
 *   (domain type with `entry_id`, `content`, `similarity`, `metadata?`).
 *   The recall DTO mirrors Brain's SearchResult HTTP response (id, hybrid_score,
 *   cross_encoder_score, etc.) — a different shape. It is renamed `RecallChunk`
 *   here to avoid clobbering the SDK's BrainChunk domain type. Both coexist cleanly.
 *
 * @public
 */

// ─── RecallChunk — mirrors SearchResult fields ───────────────────────────────

/**
 * A retrieved memory chunk from Brain's agent search engine.
 *
 * Named `RecallChunk` (not `BrainChunk`) to avoid collision with the SDK's
 * domain-level `BrainChunk` (orchestration/ooda/brain-context.ts) which has
 * `entry_id`, `content`, `similarity`, `metadata?`. This type mirrors the HTTP
 * SearchResult DTO from brain-protocol/src/services/search.service.ts.
 *
 * Field provenance: `SearchResult` interface in
 * `brain-protocol/src/services/search.service.ts` (confirmed 2026-05-29).
 * Only the fields stable across retrieval strategies are exposed here;
 * internal flags (_matchedViaProposition, etc.) are excluded.
 * @public
 */
export interface RecallChunk {
  /** Knowledge entry UUID. Maps to SearchResult.id. */
  readonly id: string;
  /** Text content of the chunk. */
  readonly content: string;
  /** Hybrid retrieval score (RRF-based). null when single-path retrieval. */
  readonly hybrid_score: number | null;
  /** Cross-encoder reranking score. null when reranking not applied. */
  readonly cross_encoder_score: number | null;
  /** Cosine similarity vs the query embedding. */
  readonly similarity: number | null;
  /** Content category (e.g. "decision", "pattern"). */
  readonly category: string;
  /** Free-form tags. */
  readonly tags: readonly string[];
  /** ISO creation date. */
  readonly created_at: string;
  /** Brain workspace ID this chunk belongs to. null = default workspace. */
  readonly brain_id: string | null;
  /** Human-readable brain workspace slug. */
  readonly brain_slug: string | null;

  // ── Egress governance fields (brain-protocol PR #105, additive/optional:
  //    ABSENT on pre-#105 servers, nullable once present) ────────────────────
  /** Normalized score ∈ [0,1]. null = no usable signal. Absent = legacy server. */
  readonly score?: number | null;
  /**
   * Semantics of `score`: `cross_encoder`/`similarity` are ABSOLUTE calibrated
   * scores (a fixed floor like 0.55 is valid) ; `fused_relative` means the raw
   * value was a rank-fusion magnitude (~0.03-0.07) normalized RELATIVE to the
   * best chunk of this response (top = 1.0) — never apply an absolute floor.
   */
  readonly score_source?: "cross_encoder" | "similarity" | "fused_relative" | (string & {}) | null;
  /** Sensitivity tier of the source entry. null = unknown (stamp failed / entry gone). */
  readonly sensitivity_label?:
    | "public"
    | "internal"
    | "confidential"
    | "secret"
    | (string & {})
    | null;
  /** PII flag of the source entry. null = unknown. */
  readonly pii_requires_encryption?: boolean | null;
}

// ─── FreshnessMarker ─────────────────────────────────────────────────────────

/**
 * Temporal validity marker for a retrieved chunk.
 *
 * Populated from bi-temporal metadata (t_valid_from / t_valid_to) carried
 * by SearchResult. Stage 0: always `[]`. Stage 3+ will compute `stale`
 * from `t_valid_to < now`.
 * @public
 */
export interface FreshnessMarker {
  /** Entry id (UUID string or legacy numeric id as string). */
  readonly entryId: string;
  /** ISO date: earliest valid time. Absent when not set on the entry. */
  readonly validFrom?: string;
  /** ISO date: expiry time. Absent when entry has no TTL. */
  readonly validUntil?: string;
  /** true when validUntil < Date.now(). Always false in Stage 0. */
  readonly stale: boolean;
}

// ─── RecallOptions ───────────────────────────────────────────────────────────

/**
 * Options for a recall() call.
 *
 * `mode` is REQUIRED:
 *   - "chunks" — return raw chunks to the agent (multi-hop, agentic use).
 *   - "answer" — return the synthesised string answer from the router.
 *
 * `tier` controls which retrieval engine is used:
 *   - "auto"    (default) — client-side heuristic picks fast vs agentic.
 *   - "fast"    — single-hop GET /api/knowledge?q= (cheap, low latency).
 *   - "agentic" — multi-hop POST /api/knowledge/search/agent (higher cost).
 * @public
 */
export interface RecallOptions {
  /**
   * Retrieval tier. Defaults to "auto" (see `tier` in brain-recall.ts for
   * the auto-gate heuristic).
   */
  readonly tier?: "auto" | "fast" | "agentic";
  /** Max chunks returned. Maps to Brain top_k (1..20). Default: 10. */
  readonly topK?: number;
  /**
   * Minimum similarity threshold for chunk inclusion.
   * Applied client-side after retrieval (Brain does not expose a threshold
   * on the agent endpoint). Range [0, 1]. Default: 0 (no filter).
   */
  readonly minSimilarity?: number;
  /** Restrict retrieval to specific Brain workspace IDs (UUIDs). */
  readonly brainIds?: readonly string[];
  /** Tag filter forwarded to Brain. */
  readonly tags?: readonly string[];
  /** Whether to return raw chunks or a synthesised answer string. */
  readonly mode: "chunks" | "answer";
}

// ─── RecallResult ────────────────────────────────────────────────────────────

/**
 * Normalised result of a recall() call, regardless of tier or mode.
 *
 * On degraded path (timeout, network error, Brain down), all arrays are
 * empty, answer is null, strategy_used is "degraded", hops_used is 0.
 * brainRecall() NEVER throws.
 * @public
 */
export interface RecallResult {
  /** Retrieved chunks (may be empty on degraded path or fast tier with no results). */
  readonly chunks: readonly RecallChunk[];
  /**
   * Synthesised answer string from the agentic router.
   * null on fast tier, degraded path, or when mode="chunks".
   */
  readonly answer: string | null;
  /**
   * Strategy actually used by the Brain router, or "single-shot" for fast
   * tier, or "degraded" on error path.
   */
  readonly strategy_used: string;
  /** Number of retrieval hops. 0 on fast tier or degraded. */
  readonly hops_used: number;
  /** Chunk entry IDs — convenience shortcut, derived from chunks[].id. */
  readonly refs: readonly string[];
  /**
   * Temporal freshness markers. Stage 0: always [].
   * Stage 3+ will populate from bi-temporal metadata.
   */
  readonly freshness: readonly FreshnessMarker[];
}

// ─── BrainRecallPort ─────────────────────────────────────────────────────────

/**
 * Port interface for memory recall.
 *
 * Implementations: `brainRecallImpl` (brain-recall.ts).
 * Promoted to SDK port per ADR-ECO-065 (sprint-805 Stage 2).
 * @public
 */
export interface BrainRecallPort {
  recall(query: string, opts: RecallOptions): Promise<RecallResult>;
}
