/**
 * Episodic memory recall — weighted score combination (cosine + recency + importance).
 *
 * Despite the file name (RRF — Reciprocal Rank Fusion), the algorithm used
 * for CC v3.1 is a **linear combination of normalized components**:
 *
 *   score(e) = α · cosine_sim(q, e.embedding)
 *            + β · exp(-Δt / τ)               // recency decay
 *            + γ · importance(e)               // [0,1]
 *
 *   defaults: α=0.5, β=0.3, γ=0.2, τ=14 days
 *
 * This shape was chosen over pure RRF because the three signals are
 * heterogeneous (similarity, time, salience) and combining them via rank
 * fusion would erase the magnitude information that callers care about
 * (e.g. "near-perfect cosine match" vs "loosely related").
 *
 * Pluggable scorers — callers provide functions mapping an entry to each
 * component so the algorithm is decoupled from storage details (embedding
 * column, importance field name, etc.).
 *
 * @see ../ports/brain.ts — EpisodicMemoryEntry
 * @see ADR-ECO-034 §"AgentPersona via Brain Tier 3 semantic" (companion)
 * @public
 */

import type { EpisodicMemoryEntry } from "../ports/brain.js";

/**
 * Default weights — sum to 1.0.
 * @public
 */
export const DEFAULT_RRF_WEIGHTS = {
  cosine: 0.5,
  recency: 0.3,
  importance: 0.2,
} as const;

/**
 * Default recency half-life (14 days in ms).
 * @public
 */
export const DEFAULT_RECENCY_HALFLIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** @public */
export interface RrfWeights {
  cosine: number;
  recency: number;
  importance: number;
}

/** @public */
export interface RrfOptions {
  weights?: Partial<RrfWeights>;
  /** Half-life for recency decay (default: 14 days). */
  recencyHalflifeMs?: number;
  /** Cap on returned entries (default: unbounded). */
  topK?: number;
  /** Override "now" for deterministic tests. */
  now?: () => number;
}

/** @public */
export interface ScoreComponents {
  cosine: number;
  recency: number;
  importance: number;
}

/** @public */
export interface ScoredEntry<T> {
  entry: T;
  score: number;
  components: ScoreComponents;
}

/** @public */
export interface RrfScorers<T> {
  /** Cosine similarity ∈ [-1, 1] — non-finite values clamped to 0. */
  cosine: (entry: T) => number;
  /** Timestamp (ms epoch) used for recency decay. Negative → drop the entry. */
  timestamp: (entry: T) => number;
  /** Salience ∈ [0, 1]. Out-of-range values clamped. */
  importance: (entry: T) => number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns 0 if either vector is empty / zero-norm / mismatched length —
 * never throws. This makes the function safe to compose into scorers that
 * may receive partial entries.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Recency score in [0, 1]: exp(-ln(2) · Δt / halflife).
 *   - 1.0 at Δt = 0
 *   - 0.5 at Δt = halflife
 *   - approaches 0 as Δt → ∞
 *
 * `nowMs` and `timestampMs` are epoch ms. Future timestamps (Δt < 0) clamp
 * to 1.0 (treated as "right now").
 * @public
 */
export function recencyScore(nowMs: number, timestampMs: number, halflifeMs: number): number {
  if (halflifeMs <= 0) return 0;
  const dt = Math.max(0, nowMs - timestampMs);
  return Math.exp((-Math.LN2 * dt) / halflifeMs);
}

/** Clamp to [0, 1]; NaN / non-finite → 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamp cosine output (−1..1) to ≥0 to avoid negative contributions. */
function clampCosineToPos(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

// ─── Generic scorer ───────────────────────────────────────────────────────────

/**
 * Score a batch of entries via the weighted combination. The result is sorted
 * by descending score and trimmed to `topK` when set.
 *
 * Negative timestamps (per `scorers.timestamp`) cause the entry to be dropped
 * entirely — this is the cheap way for a scorer to signal "skip" (e.g. row
 * lacks the field).
 * @public
 */
export function scoreEntries<T>(
  entries: T[],
  scorers: RrfScorers<T>,
  opts: RrfOptions = {},
): ScoredEntry<T>[] {
  const weights: RrfWeights = {
    cosine: opts.weights?.cosine ?? DEFAULT_RRF_WEIGHTS.cosine,
    recency: opts.weights?.recency ?? DEFAULT_RRF_WEIGHTS.recency,
    importance: opts.weights?.importance ?? DEFAULT_RRF_WEIGHTS.importance,
  };
  const halflifeMs = opts.recencyHalflifeMs ?? DEFAULT_RECENCY_HALFLIFE_MS;
  const nowMs = (opts.now ?? Date.now)();

  const scored: ScoredEntry<T>[] = [];
  for (const entry of entries) {
    const ts = scorers.timestamp(entry);
    if (ts < 0) continue;
    const cosine = clampCosineToPos(scorers.cosine(entry));
    const recency = recencyScore(nowMs, ts, halflifeMs);
    const importance = clamp01(scorers.importance(entry));
    const score =
      weights.cosine * cosine + weights.recency * recency + weights.importance * importance;
    scored.push({
      entry,
      score,
      components: { cosine, recency, importance },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  if (opts.topK !== undefined && opts.topK >= 0) {
    return scored.slice(0, opts.topK);
  }
  return scored;
}

// ─── Concrete recall over EpisodicMemoryEntry ────────────────────────────────

/**
 * The agent-sdk EpisodicMemoryEntry does NOT carry an embedding column —
 * embeddings live in the storage layer (Postgres pgvector). To enable
 * pluggable cosine scoring, the caller may attach an embedding via the
 * `embedding` field on `metadata`, or supply a custom resolver.
 * @public
 */
export type EpisodicCosineFn = (entry: EpisodicMemoryEntry) => number;

/** Default cosine: 0 (no embedding available — relies on recency + importance only). */
const ZERO_COSINE: EpisodicCosineFn = () => 0;

/** @public */
export interface RecallRrfOptions extends RrfOptions {
  /**
   * Cosine scorer — defaults to 0 (no embedding). Provide when you have a
   * pre-computed (entry × query) similarity for each entry.
   */
  cosine?: EpisodicCosineFn;
}

/**
 * Rank EpisodicMemoryEntry[] by weighted score. Convenience over scoreEntries
 * with the standard projection (timestamp = entry.timestamp,
 * importance = metadata.importance ?? 0.5).
 * @public
 */
export function recallEpisodicRrf(
  entries: EpisodicMemoryEntry[],
  opts: RecallRrfOptions = {},
): ScoredEntry<EpisodicMemoryEntry>[] {
  const cosineFn = opts.cosine ?? ZERO_COSINE;
  return scoreEntries(
    entries,
    {
      cosine: cosineFn,
      timestamp: (e) => e.timestamp,
      importance: (e) => {
        const raw = (e.metadata?.importance as unknown) ?? 0.5;
        return typeof raw === "number" ? raw : 0.5;
      },
    },
    opts,
  );
}
