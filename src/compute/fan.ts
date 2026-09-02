/**
 * fan.ts ; bounded parallel fan-out + DETERMINISTIC fan-in.
 *
 * Two pure combinators for the orchestration layer:
 *
 *   fanOut(items, evaluate, maxConcurrency)  ; run `evaluate` over `items` with
 *     bounded concurrency ; RESULT order = INPUT order (never completion order).
 *     Bounding concurrency avoids the rate-limit cascade a naive `Promise.all`
 *     over a large batch triggers (a shared provider quota is finite).
 *
 *   fanInArgmin(candidates, score, id)        ; pick the minimum-score candidate
 *     over a TOTAL ORDER with a lexicographic tie-break on a canonical id, and
 *     return the full ranked selection trace. Determinism is the point: a
 *     non-deterministic fan-in (completion-order or Map-iteration tie-break)
 *     cannot be re-executed, so it contaminates an A3 re-execution grade. The
 *     selection step under a best-of-N / DAG fan-in or any "evaluate N, keep the
 *     best" decision.
 *
 * Determinism: both are pure given their callbacks ; no clock, no randomness.
 *
 * Promoted into the published SDK per ADR-ECO-101 (W3 / I4 GATE). L1 evidence:
 * the BTC best-execution pilot (command-center apps/agents/btc-execution, commit
 * 69d817e1 ; the W3 fan-out/fan-in unit contract). Reusable by any orchestrator.
 */

/**
 * Run `evaluate` over `items` with bounded concurrency. Results stay in INPUT
 * order regardless of completion order. At most `maxConcurrency` evaluations are
 * in flight at once.
 */
export async function fanOut<T, R>(
  items: readonly T[],
  evaluate: (item: T, index: number) => Promise<R>,
  maxConcurrency = 8,
): Promise<R[]> {
  if (maxConcurrency < 1) {
    throw new RangeError("fanOut: maxConcurrency must be >= 1");
  }
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await evaluate(items[i], i);
    }
  }
  const poolSize = Math.min(maxConcurrency, items.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

export interface FanInResult<C> {
  readonly winner: C;
  /** All candidates with their score, in the deterministic selection order. */
  readonly ranked: readonly { readonly id: string; readonly score: number }[];
}

/**
 * Deterministic fan-in: pick the minimum-score candidate, breaking ties by the
 * lexicographically smallest id. Returns the winner plus the full ranked
 * selection trace. Throws on an empty candidate set (fail-closed).
 */
export function fanInArgmin<C>(
  candidates: readonly C[],
  score: (candidate: C) => number,
  id: (candidate: C) => string,
): FanInResult<C> {
  if (candidates.length === 0) {
    throw new RangeError("fanInArgmin: empty candidate set");
  }
  const scored = candidates.map((c) => ({ c, id: id(c), score: score(c) }));
  scored.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    winner: scored[0].c,
    ranked: scored.map((s) => ({ id: s.id, score: s.score })),
  };
}
