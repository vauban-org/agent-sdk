/**
 * assertCacheSafe — prompt-cache prefix invariant guard.
 *
 * Promoted from apps/agents/forecaster/src/recall/cache-safety.ts to SDK port
 * per ADR-ECO-065 (sprint-805 Stage 2).
 *
 * Invariant (docs/agentic-rag/cache-safety-invariant.md §1):
 *   The cacheable prefix (system instructions + T0 stable block) MUST be
 *   byte-identical on every turn. Any drift busts the Anthropic prompt cache
 *   (5-min TTL, 10x cheaper after first turn) and silently inflates cost.
 *
 * This guard compares the prefix captured BEFORE memory injection against the
 * prefix captured AFTER. If they differ, memory leaked into the cacheable
 * region (or a per-turn value was injected upstream) — that is a violation.
 *
 * Used by Stage 1/3 wiring tests to prove memory_context is appended AFTER the
 * prefix, never inside it.
 *
 * @public
 */

/**
 * Error thrown when the cacheable prefix changed between two captures.
 * @public
 */
export class CacheSafetyViolationError extends Error {
  /** Zero-based index of the first byte that differs. */
  readonly divergenceIndex: number;

  constructor(message: string, divergenceIndex: number) {
    super(message);
    this.name = "CacheSafetyViolationError";
    this.divergenceIndex = divergenceIndex;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Find the index of the first differing character between two strings,
 * or -1 if they are identical.
 */
function firstDivergence(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : min;
}

/**
 * Assert that two cacheable-prefix snapshots are byte-identical.
 *
 * @param prefixBefore - the cacheable prefix captured before memory injection
 * @param prefixAfter  - the cacheable prefix captured after memory injection
 * @throws CacheSafetyViolationError when the two prefixes differ
 * @public
 */
export function assertCacheSafe(prefixBefore: string, prefixAfter: string): void {
  if (prefixBefore === prefixAfter) return;

  const idx = firstDivergence(prefixBefore, prefixAfter);
  const ctxBefore = prefixBefore.slice(Math.max(0, idx - 20), idx + 20);
  const ctxAfter = prefixAfter.slice(Math.max(0, idx - 20), idx + 20);

  throw new CacheSafetyViolationError(
    `Cacheable prefix changed at index ${idx} (lengths ${prefixBefore.length} → ${prefixAfter.length}). before=${JSON.stringify(ctxBefore)} after=${JSON.stringify(
      ctxAfter,
    )}. Retrieved memory must live in a dynamic <memory_context> block AFTER the cacheable prefix, never inside it (see cache-safety-invariant.md).`,
    idx,
  );
}
