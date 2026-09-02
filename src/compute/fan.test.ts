/**
 * fanOut / fanInArgmin ; unit contract (ADR-ECO-101 W3 / I4).
 *
 * Proves fan-out keeps results in INPUT order despite varying completion order
 * and bounds concurrency, and that fan-in is a deterministic argmin with a
 * lexicographic tie-break + a complete ranked selection trace.
 */

import { describe, expect, it } from "vitest";
import { fanInArgmin, fanOut } from "./fan.js";

/** Resolve after `n` microtask turns (deterministic, no timers). */
function microWait(n: number): Promise<void> {
  let p = Promise.resolve();
  for (let k = 0; k < n; k++) p = p.then(() => undefined);
  return p;
}

describe("fanOut ; bounded parallel, input-ordered", () => {
  it("keeps results in input order even when later items finish first", async () => {
    const items = [0, 1, 2, 3, 4];
    // item 0 waits the longest, item 4 the shortest -> completion order reversed.
    const out = await fanOut(items, async (i) => {
      await microWait(items.length - i);
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40]);
  });

  it("never runs more than maxConcurrency evaluations at once", async () => {
    let active = 0;
    let maxActive = 0;
    await fanOut(
      [0, 1, 2, 3, 4],
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await microWait(3);
        active -= 1;
        return 0;
      },
      2,
    );
    expect(maxActive).toBe(2);
  });

  it("handles an empty input", async () => {
    expect(await fanOut([], async () => 1)).toEqual([]);
  });

  it("rejects maxConcurrency < 1", async () => {
    await expect(fanOut([1], async (x) => x, 0)).rejects.toThrow(RangeError);
  });
});

describe("fanInArgmin ; deterministic selection", () => {
  const cs = [
    { id: "b", score: 5 },
    { id: "a", score: 3 },
    { id: "c", score: 3 },
  ];

  it("picks the minimum-score candidate", () => {
    const r = fanInArgmin(
      cs,
      (c) => c.score,
      (c) => c.id,
    );
    expect(r.winner.id).toBe("a");
  });

  it("breaks ties by lexicographically smallest id", () => {
    // a and c both score 3 ; a < c wins.
    const r = fanInArgmin(
      cs,
      (c) => c.score,
      (c) => c.id,
    );
    expect(r.winner.id).toBe("a");
    expect(r.ranked.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("returns the full ranked selection trace", () => {
    const r = fanInArgmin(
      cs,
      (c) => c.score,
      (c) => c.id,
    );
    expect(r.ranked).toEqual([
      { id: "a", score: 3 },
      { id: "c", score: 3 },
      { id: "b", score: 5 },
    ]);
  });

  it("throws on an empty candidate set (fail-closed)", () => {
    expect(() =>
      fanInArgmin(
        [],
        (c: { score: number }) => c.score,
        () => "x",
      ),
    ).toThrow(RangeError);
  });
});
