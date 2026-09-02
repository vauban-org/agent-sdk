/**
 * tests/verify-novelty.test.ts
 *
 * noveltyLens (the diversity gate) ; deterministic token-Jaccard, no LLM. Verifies
 * the similarity metric, the lens shape, and end-to-end diversity gating: soft
 * discounts a near-duplicate (lone soft refuter ⇒ no quorum kill), hard kills it.
 */

import { describe, expect, it } from "vitest";
import { runVerifierBattery } from "../src/compute/battery/battery.js";
import type { BatteryLens, RunVerifierBatteryOptions } from "../src/compute/battery/types.js";
import { RecordedClock } from "../src/replay/clock.js";
import { noveltyLens, tokenJaccard } from "../src/verify/verifiers/novelty.js";

function opts(over: Partial<RunVerifierBatteryOptions> = {}): RunVerifierBatteryOptions {
  return {
    clock: new RecordedClock([1_700_000_000_000, 1_700_000_000_050]),
    runId: "novelty-run-001",
    adrEco: "ADR-ECO-045",
    ...over,
  };
}

const affirmConst = (score: number): BatteryLens<string> => ({
  verifier: {
    name: "content",
    evaluate: () => ({ score, rationale: `const ${score}` }),
  },
  polarity: "affirm",
  criticality: "soft",
  signature: { engine: "rule" },
});

describe("tokenJaccard", () => {
  it("identical → 1", () => expect(tokenJaccard("buy five units", "buy five units")).toBe(1));
  it("disjoint → 0", () => expect(tokenJaccard("buy five", "sell ten")).toBe(0));
  it("partial overlap {b,c}/{a,b,c,d} = 0.5", () =>
    expect(tokenJaccard("a b c", "b c d")).toBeCloseTo(0.5, 10));
  it("both empty → 1", () => expect(tokenJaccard("", "")).toBe(1));
  it("one empty → 0", () => expect(tokenJaccard("a", "")).toBe(0));
  it("case-insensitive", () => expect(tokenJaccard("Buy FIVE", "buy five")).toBe(1));
});

describe("noveltyLens", () => {
  it("is a soft refute statistical lens by default", () => {
    const l = noveltyLens<string>(["x"]);
    expect(l.polarity).toBe("refute");
    expect(l.signature.engine).toBe("statistical");
    expect(l.criticality).toBe("soft");
    expect(l.verifier.name).toBe("novelty-gate");
  });

  it("empty reference ⇒ score 0 (everything novel)", async () => {
    const l = noveltyLens<string>([]);
    expect(await l.verifier.evaluate("anything at all")).toMatchObject({
      score: 0,
    });
  });

  it("identical to a reference ⇒ score 1", async () => {
    const l = noveltyLens<string>(["buy five units"]);
    expect((await l.verifier.evaluate("buy five units")).score).toBe(1);
  });

  it("disjoint from references ⇒ score 0", async () => {
    const l = noveltyLens<string>(["buy five units"]);
    expect((await l.verifier.evaluate("totally different content here")).score).toBe(0);
  });
});

describe("noveltyLens in a battery (diversity gate)", () => {
  const reference = ["buy five units now"];
  const DUP = "buy five units now";
  const NOVEL = "sell ten shares tomorrow";

  it("soft: discounts the near-duplicate without killing, prefers the novel one", async () => {
    const d = await runVerifierBattery<string>(
      "produce",
      [DUP, NOVEL],
      [affirmConst(0.9), noveltyLens<string>(reference)],
      opts(),
    );
    expect(d.acceptedIndex).toBe(1);
    expect(d.accepted).toBe(NOVEL);
    // lone soft refuter ⇒ no quorum: DUP is discounted to ~0 but not killed.
    expect(d.verdicts[0].killed).toBe(false);
    expect(d.verdicts[0].compositeScore).toBeCloseTo(0, 10);
  });

  it("hard: kills the near-duplicate outright", async () => {
    const d = await runVerifierBattery<string>(
      "produce",
      [DUP, NOVEL],
      [affirmConst(0.9), noveltyLens<string>(reference, { criticality: "hard" })],
      opts(),
    );
    expect(d.verdicts[0].killed).toBe(true);
    expect(d.acceptedIndex).toBe(1);
    const dupReject = d.rejected.find((r) => r.candidateIndex === 0);
    expect(dupReject?.reason).toMatch(/^killed:/);
  });
});
