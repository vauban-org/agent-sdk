/**
 * tests/best-of-n.test.ts
 *
 * Cap 1 — verifier-driven best-of-N (orchestration/dag/best-of-n.ts).
 * Deterministic, no LLM, no network. Covers:
 *   - bestOfN returns the verifier-accepted candidate;
 *   - empty candidates → accepted null fail-closed (verifier NOT called);
 *   - all-rejected → accepted null fail-closed;
 *   - batteryVerifier rejects an llm-judge-only lens set (ADR-068 anchor invariant);
 *   - batteryVerifier requires a non-empty adrEco;
 *   - batteryVerifier picks the battery-accepted candidate and surfaces its reason.
 */

import { describe, expect, it, vi } from "vitest";
import {
  bestOfN,
  batteryVerifier,
} from "../src/orchestration/dag/best-of-n.js";
import type {
  DagNodeSpec,
  NodeInputs,
  Verifier,
  VerifierVerdict,
} from "../src/orchestration/dag/contracts.js";
import type { BatteryLens } from "../src/compute/battery/types.js";
import { RecordedClock } from "../src/replay/clock.js";

// runVerifierBattery reads clock.now() exactly twice (start + end) per run.
const clock = () => new RecordedClock([1_700_000_000_000, 1_700_000_000_050]);

const node: DagNodeSpec = { id: "n1", task: "pick the best string" };
const inputs: NodeInputs = { upstream: "ctx" };

// ─── Candidate type + lenses ───────────────────────────────────────────────────

interface Cand {
  readonly text: string;
  readonly quality: number; // [0,1]
}

// Hard affirm rule lens: a candidate's own quality field is the score (deterministic anchor).
const qualityLens: BatteryLens<Cand> = {
  verifier: {
    name: "candidate-quality",
    evaluate: (c) => ({ score: c.quality, rationale: `quality=${c.quality}` }),
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

// An llm-judge lens (no deterministic anchor on its own).
const judgeLens: BatteryLens<Cand> = {
  verifier: {
    name: "llm-judge",
    evaluate: (c) => ({ score: c.quality, rationale: "judged" }),
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "llm-judge", model: "fake" },
};

// ─── bestOfN ───────────────────────────────────────────────────────────────────

describe("bestOfN", () => {
  it("returns the verifier-accepted candidate", async () => {
    const candidates: Cand[] = [
      { text: "a", quality: 0.1 },
      { text: "b", quality: 0.9 },
    ];
    // Fake verifier: picks index 1.
    const verifier: Verifier<Cand> = async () => ({
      accepted: candidates[1],
      acceptedIndex: 1,
      reason: "picked b",
    });

    const verdict = await bestOfN<Cand>({ candidates, verifier, node, inputs });
    expect(verdict.acceptedIndex).toBe(1);
    expect(verdict.accepted).toEqual({ text: "b", quality: 0.9 });
    expect(verdict.reason).toBe("picked b");
  });

  it("forwards node + inputs context to the verifier", async () => {
    const candidates: Cand[] = [{ text: "a", quality: 1 }];
    const spy = vi.fn<Verifier<Cand>>(async () => ({
      accepted: candidates[0],
      acceptedIndex: 0,
      reason: "ok",
    }));
    await bestOfN<Cand>({ candidates, verifier: spy, node, inputs });
    expect(spy).toHaveBeenCalledWith(candidates, { node, inputs });
  });

  it("empty candidates → accepted null fail-closed, verifier NOT invoked", async () => {
    const spy = vi.fn<Verifier<Cand>>(async () => {
      throw new Error("verifier must not be called for empty candidates");
    });
    const verdict = await bestOfN<Cand>({
      candidates: [],
      verifier: spy,
      node,
      inputs,
    });
    expect(verdict.accepted).toBeNull();
    expect(verdict.acceptedIndex).toBe(-1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("all-rejected verifier verdict propagates as accepted null", async () => {
    const candidates: Cand[] = [{ text: "a", quality: 0 }];
    const verifier: Verifier<Cand> = async () => ({
      accepted: null,
      acceptedIndex: -1,
      reason: "all rejected",
    });
    const verdict = await bestOfN<Cand>({ candidates, verifier, node, inputs });
    expect(verdict.accepted).toBeNull();
    expect(verdict.acceptedIndex).toBe(-1);
  });
});

// ─── batteryVerifier ───────────────────────────────────────────────────────────

describe("batteryVerifier", () => {
  it("rejects a lens set with only an llm-judge lens (ADR-068 anchor invariant)", () => {
    expect(() =>
      batteryVerifier<Cand>({
        lenses: [judgeLens],
        adrEco: "ADR-ECO-068",
        clock: clock(),
      }),
    ).toThrow(/non-llm-judge lens/i);
  });

  it("requires a non-empty adrEco", () => {
    expect(() =>
      batteryVerifier<Cand>({
        lenses: [qualityLens],
        adrEco: "  ",
        clock: clock(),
      }),
    ).toThrow(/adrEco/i);
  });

  it("picks the battery-accepted candidate and surfaces its reason", async () => {
    const candidates: Cand[] = [
      { text: "weak", quality: 0.2 },
      { text: "strong", quality: 0.95 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-068",
      clock: clock(),
      runId: "node-bon-1",
    });

    const verdict: VerifierVerdict<Cand> = await verifier(candidates, {
      node,
      inputs,
    });
    // qualityLens is a hard affirm rule lens; threshold 0.5 → "weak" killed, "strong" survives.
    expect(verdict.acceptedIndex).toBe(1);
    expect(verdict.accepted).toEqual({ text: "strong", quality: 0.95 });
    expect(verdict.reason).toMatch(/accepted candidate 1/);
  });

  it("fails closed (accepted null) when the battery kills every candidate", async () => {
    const candidates: Cand[] = [
      { text: "bad-1", quality: 0.1 },
      { text: "bad-2", quality: 0.0 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-068",
      clock: clock(),
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect(verdict.accepted).toBeNull();
    expect(verdict.acceptedIndex).toBe(-1);
    expect(verdict.reason).toMatch(/fail-closed/i);
  });

  it("short-circuits empty candidates fail-closed without invoking the battery", async () => {
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-068",
      clock: clock(),
    });
    const verdict = await verifier([], { node, inputs });
    expect(verdict.accepted).toBeNull();
    expect(verdict.acceptedIndex).toBe(-1);
  });

  it("accepts a mixed lens set as long as a deterministic anchor is present", async () => {
    const candidates: Cand[] = [{ text: "ok", quality: 0.9 }];
    const verifier = batteryVerifier<Cand>({
      lenses: [judgeLens, qualityLens], // judge + deterministic anchor
      adrEco: "ADR-ECO-068",
      clock: clock(),
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect(verdict.acceptedIndex).toBe(0);
  });
});

// ─── Cap 1.5 — MoB selection policy ─────────────────────────────────────────────

import { mobSelectIndex } from "../src/orchestration/dag/best-of-n.js";
import type { CandidateVerdict } from "../src/compute/battery/types.js";

function cv(
  candidateIndex: number,
  candidateHash: string,
  compositeScore: number,
  killed = false,
): CandidateVerdict {
  return {
    candidateIndex,
    candidateHash,
    lensVerdicts: [],
    killed,
    killReason: killed ? "killed" : null,
    compositeScore,
  };
}

describe("mobSelectIndex (Cap 1.5)", () => {
  it("returns null for no survivors (all killed / empty)", () => {
    expect(mobSelectIndex([], "seed")).toBeNull();
    expect(mobSelectIndex([cv(0, "h", 0.9, true)], "seed")).toBeNull();
  });

  it("returns the lone survivor without bootstrapping", () => {
    expect(mobSelectIndex([cv(3, "h", 0.4)], "seed")).toBe(3);
  });

  it("never returns a killed candidate", () => {
    const v = [cv(0, "a", 0.99, true), cv(1, "b", 0.5), cv(2, "c", 0.6)];
    const idx = mobSelectIndex(v, "seed")!;
    expect(idx).not.toBe(0);
    expect([1, 2]).toContain(idx);
  });

  it("degenerates to argmax on distinct deterministic scores", () => {
    // No ties, no shared answers, deterministic anchor → global max always wins.
    const v = [cv(0, "a", 0.2), cv(1, "b", 0.95), cv(2, "c", 0.5)];
    expect(mobSelectIndex(v, "seed-x")).toBe(1);
    expect(mobSelectIndex(v, "totally-different-seed")).toBe(1);
  });

  it("on a top-score tie, picks the most FREQUENT answer (MoB ≠ argmax)", () => {
    // index 0 = answer A (singleton), indices 1..3 = answer B (×3), all tie 0.9.
    // Plain argmax would take index 0 (first max). MoB takes a B.
    const v = [
      cv(0, "hashA", 0.9),
      cv(1, "hashB", 0.9),
      cv(2, "hashB", 0.9),
      cv(3, "hashB", 0.9),
    ];
    const idx = mobSelectIndex(v, "seed-mob")!;
    expect([1, 2, 3]).toContain(idx); // a B, not A
    expect(idx).toBe(1); // representative of hashB = lowest-index member
  });

  it("is deterministic: same seed → identical selection (replay-safe)", () => {
    const v = [
      cv(0, "hashA", 0.9),
      cv(1, "hashB", 0.9),
      cv(2, "hashB", 0.9),
      cv(3, "hashB", 0.9),
    ];
    const a = mobSelectIndex(v, "fixed-seed");
    const b = mobSelectIndex(v, "fixed-seed");
    expect(a).toBe(b);
  });
});

describe("batteryVerifier selection policy (Cap 1.5)", () => {
  it("defaults to argmax (byte-identical to Cap 1)", async () => {
    const candidates: Cand[] = [
      { text: "a", quality: 0.2 },
      { text: "b", quality: 0.95 },
      { text: "c", quality: 0.5 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-083",
      clock: clock(),
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect(verdict.acceptedIndex).toBe(1);
    expect(verdict.reason).not.toMatch(/\[mob/);
  });

  it("selection=mob flips to the frequent answer on a top-score tie", async () => {
    // Identical values → identical canonical hash, so the three "B" collapse.
    const candidates: Cand[] = [
      { text: "A", quality: 0.9 },
      { text: "B", quality: 0.9 },
      { text: "B", quality: 0.9 },
      { text: "B", quality: 0.9 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-083",
      clock: clock(),
      selection: "mob",
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect([1, 2, 3]).toContain(verdict.acceptedIndex); // a "B", not index 0 ("A")
    expect(verdict.accepted).toEqual({ text: "B", quality: 0.9 });
    expect(verdict.reason).toMatch(/\[mob; argmax was 0\]/);
  });

  it("selection=mob still fail-closes when every candidate is killed", async () => {
    const candidates: Cand[] = [
      { text: "a", quality: 0 },
      { text: "b", quality: 0 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens], // 0 < default 0.5 threshold → all killed
      adrEco: "ADR-ECO-083",
      clock: clock(),
      selection: "mob",
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect(verdict.accepted).toBeNull();
    expect(verdict.acceptedIndex).toBe(-1);
    expect(verdict.reason).toMatch(/fail-closed/i);
  });

  it("selection=mob notes mob=argmax when no tie changes the pick", async () => {
    const candidates: Cand[] = [
      { text: "a", quality: 0.3 },
      { text: "b", quality: 0.95 },
    ];
    const verifier = batteryVerifier<Cand>({
      lenses: [qualityLens],
      adrEco: "ADR-ECO-083",
      clock: clock(),
      selection: "mob",
    });
    const verdict = await verifier(candidates, { node, inputs });
    expect(verdict.acceptedIndex).toBe(1);
    expect(verdict.reason).toMatch(/\[mob=argmax\]/);
  });
});
