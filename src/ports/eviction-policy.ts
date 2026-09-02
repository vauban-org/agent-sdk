/**
 * Brain Working Memory Eviction Policies — Sprint A (brain-eviction).
 *
 * INTEGRATION SKETCH (for coordinator wave B):
 * ─────────────────────────────────────────────
 * In `src/ports/brain.ts`, extend `WorkingMemoryPort` with:
 *
 *   evict(policy: EvictionPolicy, targetSize: number): Promise<string[]>;
 *
 * And in `InMemoryWorkingMemory`, implement:
 *
 *   async evict(policy: EvictionPolicy, targetSize: number): Promise<string[]> {
 *     const now = Date.now();
 *     const entries: WorkingMemoryEntry[] = [...this.store.entries()]
 *       .filter(([, v]) => v.expiresAt > now)
 *       .map(([compoundKey, v]) => ({
 *         id: compoundKey,
 *         content: v.value,
 *         lastAccessedAt: v.lastAccessedAt ?? v.expiresAt,
 *         importance: v.importance ?? 0.5,
 *         agentTag: v.agentTag,
 *         pinned: v.pinned,
 *         size: v.size,
 *       }));
 *     const toEvict = policy.select(entries, targetSize);
 *     for (const id of toEvict) this.store.delete(id);
 *     return toEvict;
 *   }
 *
 * The `WorkingMemoryEntry` type in this module mirrors the shape callers
 * must provide — no import loop with `brain.ts` is required.
 * @public
 */

// ─── Core types ──────────────────────────────────────────────────────────────

export interface WorkingMemoryEntry {
  /** Compound key (e.g. `runId:key`) — opaque to policies. */
  id: string;
  /** Arbitrary entry payload. */
  content: unknown;
  /** Unix epoch ms of last read or write. */
  lastAccessedAt: number;
  /** Relative importance in [0, 1]. Higher = more important. */
  importance: number;
  /** Optional tag linking entry to an agent. Used by AgentControlled. */
  agentTag?: string;
  /** If true, the entry is never selected for eviction. */
  pinned?: boolean;
  /** Optional byte/token size for budget-aware usage. */
  size?: number;
}

/** @public */
export interface EvictionPolicy {
  /** Human-readable policy name. */
  readonly name: string;
  /**
   * Returns the IDs of entries to evict so that the remaining count
   * satisfies `remaining.length <= targetSize`.
   *
   * Guarantees:
   * - `pinned: true` entries are never included.
   * - Returns `[]` when `entries.length <= targetSize`.
   * - Deterministic: same inputs → same output.
   */
  select(entries: readonly WorkingMemoryEntry[], targetSize: number): string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Filter out pinned entries and decide how many need to go. */
function evictableAndCount(
  entries: readonly WorkingMemoryEntry[],
  targetSize: number,
): { evictable: WorkingMemoryEntry[]; count: number } {
  if (entries.length <= targetSize) return { evictable: [], count: 0 };
  const evictable = entries.filter((e) => !e.pinned);
  const count = entries.length - targetSize;
  return { evictable, count };
}

// ─── LRU Policy ──────────────────────────────────────────────────────────────

/**
 * Evicts entries with the oldest `lastAccessedAt` first.
 * Ties are broken by `id` ASC for determinism.
 * @public
 */
export const lruPolicy: EvictionPolicy = {
  name: "lru",
  select(entries, targetSize) {
    const { evictable, count } = evictableAndCount(entries, targetSize);
    if (count === 0) return [];

    const sorted = [...evictable].sort((a, b) => {
      const diff = a.lastAccessedAt - b.lastAccessedAt;
      return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return sorted.slice(0, count).map((e) => e.id);
  },
};

// ─── ImportanceWeighted Policy ────────────────────────────────────────────────

export interface ImportanceWeightedOptions {
  /** Weight applied to normalized recency score (default 0.5). */
  recencyWeight?: number;
  /** Weight applied to importance score (default 0.5). */
  importanceWeight?: number;
}

/**
 * Scores each entry as:
 *   score = recencyWeight * normalizedRecency + importanceWeight * importance
 *
 * Normalized recency: 1 = most recent, 0 = oldest (linear across range).
 * When all `lastAccessedAt` values are equal, normalizedRecency = 0.5 for all.
 *
 * Evicts entries with the lowest score first.
 * Ties broken by `id` ASC.
 * @public
 */
export function importanceWeightedPolicy(opts?: ImportanceWeightedOptions): EvictionPolicy {
  const rw = opts?.recencyWeight ?? 0.5;
  const iw = opts?.importanceWeight ?? 0.5;

  return {
    name: "importance-weighted",
    select(entries, targetSize) {
      const { evictable, count } = evictableAndCount(entries, targetSize);
      if (count === 0) return [];

      // Compute normalized recency
      const times = evictable.map((e) => e.lastAccessedAt);
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const timeRange = maxTime - minTime;

      const scored = evictable.map((e) => {
        const normalizedRecency = timeRange === 0 ? 0.5 : (e.lastAccessedAt - minTime) / timeRange;
        const score = rw * normalizedRecency + iw * e.importance;
        return { id: e.id, score };
      });

      scored.sort((a, b) => {
        const diff = a.score - b.score;
        return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      return scored.slice(0, count).map((s) => s.id);
    },
  };
}

// ─── AgentControlled Policy ──────────────────────────────────────────────────

/**
 * Evicts entries whose `agentTag` has the lowest priority in the map first.
 * Entries with no `agentTag` (or a tag not in the map) receive priority 0.
 * Higher priority value = kept longer.
 * Ties broken by `id` ASC.
 * @public
 */
export function agentControlledPolicy(priorities: ReadonlyMap<string, number>): EvictionPolicy {
  return {
    name: "agent-controlled",
    select(entries, targetSize) {
      const { evictable, count } = evictableAndCount(entries, targetSize);
      if (count === 0) return [];

      const getPriority = (e: WorkingMemoryEntry): number =>
        e.agentTag !== undefined ? (priorities.get(e.agentTag) ?? 0) : 0;

      const sorted = [...evictable].sort((a, b) => {
        const diff = getPriority(a) - getPriority(b);
        return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      return sorted.slice(0, count).map((e) => e.id);
    },
  };
}
