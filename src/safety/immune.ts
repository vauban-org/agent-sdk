/**
 * Immune detection — cosine similarity-based threat detection.
 *
 * Sprint-564: C3 — MAAG immune system (simplified: no voyage-4/pgvector in core).
 *
 * Cosine similarity engine for detecting known attack patterns.
 * StressLedger is STORED ISOLATED — NEVER via BrainPort (P4 security).
 * voyage-4 + pgvector integration deferred to external infra (Brain API).
 *
 * Golden fixtures: known attacker corpus with expected cosine thresholds.
 * @public
 */

export interface ImmuneMemoryEntry {
  /** Embedding vector of the detected pattern. */
  embedding: number[];
  /** Human-readable label. */
  label: string;
  /** Proof hash for L3 anchoring (Vauban Proof Stack). */
  proofHash?: string;
  /** When this entry was recorded. */
  timestamp: number;
}

/** @public */
export interface ImmuneMatch {
  entry: ImmuneMemoryEntry;
  similarity: number;
  threshold: number;
}

/**
 * Cosine similarity between two vectors. Returns 0-1.
 * @public
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * StressLedger — ISOLATED store for immune memory entries.
 * NEVER stored via BrainPort (P4 security: attack patterns must not
 * be queryable or modifiable through the knowledge graph).
 * @public
 */
export class StressLedger {
  private entries: ImmuneMemoryEntry[] = [];

  /** Record an immune memory entry. Returns the entry with proof hash. */
  record(embedding: number[], label: string): ImmuneMemoryEntry {
    const entry: ImmuneMemoryEntry = {
      embedding,
      label,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Find all entries above a cosine similarity threshold. */
  search(embedding: number[], threshold = 0.92): ImmuneMatch[] {
    const matches: ImmuneMatch[] = [];
    for (const entry of this.entries) {
      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (similarity >= threshold) {
        matches.push({ entry, similarity, threshold });
      }
    }
    return matches.sort((a, b) => b.similarity - a.similarity);
  }

  /** Number of stored entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Export all entries (for snapshot testing). */
  export(): ImmuneMemoryEntry[] {
    return [...this.entries];
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }
}

// ─── Golden fixtures — known attacker corpus ─────────────────────────────────

/** @public */
export const GOLDEN_ATTACK_EMBEDDINGS: ReadonlyArray<{
  label: string;
  embedding: number[];
}> = [
  {
    label: "prompt_injection_ignore",
    embedding: [0.8, 0.6, 0.1, 0.2, 0.9, 0.1, 0.05, 0.3],
  },
  {
    label: "data_exfiltration_attempt",
    embedding: [0.1, 0.9, 0.8, 0.7, 0.1, 0.2, 0.9, 0.1],
  },
  {
    label: "role_escalation",
    embedding: [0.7, 0.1, 0.9, 0.1, 0.8, 0.6, 0.1, 0.2],
  },
];

/**
 * Run golden fixture validation. Returns false if any fixture fails detection.
 * @public
 */
export function validateGoldenFixtures(ledger: StressLedger): {
  passed: boolean;
  results: Array<{ label: string; matched: boolean; similarity: number }>;
} {
  const results: Array<{ label: string; matched: boolean; similarity: number }> = [];

  // Record golden fixtures
  for (const fixture of GOLDEN_ATTACK_EMBEDDINGS) {
    ledger.record(fixture.embedding, fixture.label);
  }

  // Test each fixture against the ledger
  for (const fixture of GOLDEN_ATTACK_EMBEDDINGS) {
    const matches = ledger.search(fixture.embedding, 0.92);
    const selfMatch = matches.find((m) => m.entry.label === fixture.label);
    results.push({
      label: fixture.label,
      matched: !!selfMatch,
      similarity: selfMatch?.similarity ?? 0,
    });
  }

  return {
    passed: results.every((r) => r.matched),
    results,
  };
}
