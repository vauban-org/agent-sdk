/**
 * semantic-coherence — Semantic stall detector for agentic loops.
 *
 * Complements the EMA-based createCoherenceDetector (structural) with a
 * semantic dimension: detects "paraphrasing the same thing" by computing
 * mean pairwise cosine similarity over a rolling window of output embeddings.
 *
 * Reference: IBM Research "Unsupervised Cycle Detection in Agentic Applications"
 * arXiv:2511.10650 — hybrid structural + semantic achieves F1 0.72 vs 0.08
 * structural-only.
 *
 * Design constraints:
 *   - Pure module: no I/O, no side effects.
 *   - Provider-agnostic: the embed function is injected by the host; the SDK
 *     does NOT import any embedder implementation.
 *   - Defensive: throws RangeError on vector dimension mismatch to prevent
 *     silent garbage cosine values.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Optional embed function injected by the host. Returns a fixed-dim vector
 * (typically 384 for all-MiniLM-L6-v2). The SDK does NOT import any embedder
 * implementation — preserves provider-agnosticism.
 * @public
 */
export type EmbedFn = (text: string) => Promise<number[]>;

/** @public */
export interface SemanticCoherenceConfig {
  /** How many recent outputs to compare. Default 5. */
  windowSize?: number;
  /**
   * Mean pairwise cosine above which we flag a semantic stall. Default 0.85.
   * At 0.85 cosine, two sentences share > 85% directional alignment in
   * embedding space, which reliably indicates paraphrase rather than progress.
   */
  similarityThreshold?: number;
}

/** @public */
export interface SemanticCoherenceVerdict {
  isSemanticStall: boolean;
  meanCosine: number;
  /** Actual buffer length at time of verdict (may be < windowSize on early calls). */
  windowSize: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors. Returns a value in [-1, 1].
 * Both vectors must have the same length (caller's responsibility).
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  // Guard against zero-vector (all-zero embedding edge case).
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Mean pairwise cosine over all unique pairs in `vectors`.
 * Returns 0 when fewer than 2 vectors are present.
 */
function meanPairwiseCosine(vectors: number[][]): number {
  if (vectors.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vectors.length - 1; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i] as number[], vectors[j] as number[]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ─── SemanticCoherenceTracker ────────────────────────────────────────────────

/**
 * Stateful tracker that maintains a ring buffer of recent output embeddings
 * and exposes `observe()` to detect semantic stalls.
 *
 * Minimum buffer size for stall detection is 3 — a single or two-item buffer
 * is not statistically meaningful for the paraphrase pattern documented in
 * arXiv:2511.10650.
 * @public
 */
export class SemanticCoherenceTracker {
  private readonly _embedFn: EmbedFn;
  private readonly _windowSize: number;
  private readonly _threshold: number;

  /**
   * Ring buffer storing at most `_windowSize` embedding vectors.
   * New entries push to the end; when full, the oldest (front) is discarded.
   */
  private _buffer: number[][];

  /** Dimension of the first embedded vector. Subsequent calls must match. */
  private _expectedDim: number | null;

  constructor(embedFn: EmbedFn, config?: SemanticCoherenceConfig) {
    this._embedFn = embedFn;
    this._windowSize = config?.windowSize ?? 5;
    this._threshold = config?.similarityThreshold ?? 0.85;

    if (this._windowSize < 2) {
      throw new RangeError("SemanticCoherenceTracker: windowSize must be >= 2");
    }
    if (this._threshold <= 0 || this._threshold > 1) {
      throw new RangeError("SemanticCoherenceTracker: similarityThreshold must be in (0, 1]");
    }

    this._buffer = [];
    this._expectedDim = null;
  }

  /**
   * Embed `output`, push to the ring buffer, and return a verdict.
   *
   * Throws RangeError if the embedding dimension differs from the first
   * observed vector (defensive against embedder hot-swap or misconfiguration).
   */
  async observe(output: string): Promise<SemanticCoherenceVerdict> {
    const vec = await this._embedFn(output);

    if (vec.length === 0) {
      throw new RangeError("SemanticCoherenceTracker: embedFn returned an empty vector");
    }

    // Enforce consistent dimensionality across the session.
    if (this._expectedDim === null) {
      this._expectedDim = vec.length;
    } else if (vec.length !== this._expectedDim) {
      throw new RangeError(
        `SemanticCoherenceTracker: embedding dimension mismatch — expected ${this._expectedDim}, got ${vec.length}`,
      );
    }

    // Ring buffer: drop oldest when full.
    if (this._buffer.length >= this._windowSize) {
      this._buffer.shift();
    }
    this._buffer.push(vec);

    const meanCosine = meanPairwiseCosine(this._buffer);

    // Require at least 3 vectors before signalling a stall — 2-vector cosine
    // is too noisy and produces excessive false positives on short sequences.
    const isSemanticStall = this._buffer.length >= 3 && meanCosine >= this._threshold;

    return {
      isSemanticStall,
      meanCosine,
      windowSize: this._buffer.length,
    };
  }

  /** Reset the rolling buffer and forget the expected dimension. */
  reset(): void {
    this._buffer = [];
    this._expectedDim = null;
  }
}
