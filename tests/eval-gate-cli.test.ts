/**
 * tests/eval-gate-cli.test.ts
 *
 * A5 slice 4: the runnable eval gate. parseEvalDataset is the boundary guard that
 * validates an untrusted golden-dataset JSON into EvalCase[]; runGateFromDataset
 * composes runEval + gateEval; formatGateReport renders the human summary a CI step
 * prints. All pure (no fs, no process), so they are unit-testable; the workflow
 * supplies the file read + exit code.
 */

import { describe, expect, it } from "vitest";
import { formatGateReport, parseEvalDataset, runGateFromDataset } from "../src/evals/gate-cli.js";

describe("parseEvalDataset (boundary guard)", () => {
  it("parses a valid dataset incl. optional fields", () => {
    const cases = parseEvalDataset([
      { id: "a", attempts: { n: 3, c: 2 } },
      {
        id: "b",
        attempts: { n: 1, c: 1 },
        endToEnd: true,
        judge: { verdict: true, gold: false },
        tags: { stage: "spec" },
      },
    ]);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({ id: "a", attempts: { n: 3, c: 2 } });
    expect(cases[1]?.endToEnd).toBe(true);
    expect(cases[1]?.judge).toEqual({ verdict: true, gold: false });
    expect(cases[1]?.tags).toEqual({ stage: "spec" });
  });

  it("throws when the top level is not an array", () => {
    expect(() => parseEvalDataset({})).toThrow();
    expect(() => parseEvalDataset(null)).toThrow();
  });

  it("throws on a missing or empty id", () => {
    expect(() => parseEvalDataset([{ attempts: { n: 1, c: 1 } }])).toThrow(/id/);
    expect(() => parseEvalDataset([{ id: "", attempts: { n: 1, c: 1 } }])).toThrow(/id/);
  });

  it("throws on malformed attempts", () => {
    expect(() => parseEvalDataset([{ id: "a" }])).toThrow(/attempts/);
    expect(() => parseEvalDataset([{ id: "a", attempts: { n: 1 } }])).toThrow(/attempts/);
    expect(() => parseEvalDataset([{ id: "a", attempts: { n: 1.5, c: 1 } }])).toThrow(/attempts/);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => parseEvalDataset([{ id: "a", attempts: { n: 1, c: 1 }, bogus: 1 }])).toThrow(
      /unknown|unexpected|bogus/i,
    );
  });

  it("throws on a malformed judge", () => {
    expect(() =>
      parseEvalDataset([{ id: "a", attempts: { n: 1, c: 1 }, judge: { verdict: true } }]),
    ).toThrow(/judge/);
  });
});

describe("runGateFromDataset", () => {
  it("passes when the dataset meets thresholds", () => {
    const { report, gate } = runGateFromDataset(
      [
        { id: "a", attempts: { n: 1, c: 1 }, endToEnd: true },
        { id: "b", attempts: { n: 2, c: 2 }, endToEnd: true },
      ],
      { k: 1, thresholds: { minPassHatK: 0.9, minEndToEndSuccess: 0.9 } },
    );
    expect(report.total).toBe(2);
    expect(gate.pass).toBe(true);
  });

  it("fails and surfaces the breached metric", () => {
    const { gate } = runGateFromDataset([{ id: "a", attempts: { n: 2, c: 0 }, endToEnd: false }], {
      k: 1,
      thresholds: { minPassHatK: 0.5 },
    });
    expect(gate.pass).toBe(false);
    expect(gate.failures.length).toBeGreaterThan(0);
  });
});

describe("formatGateReport", () => {
  it("renders the verdict and key metrics", () => {
    const result = runGateFromDataset([{ id: "a", attempts: { n: 1, c: 1 }, endToEnd: true }], {
      k: 1,
      thresholds: { minPassHatK: 0.5 },
    });
    const text = formatGateReport(result);
    expect(text).toMatch(/GATE (PASS|FAIL)/);
    expect(text).toMatch(/pass\^k/);
  });

  it("lists the failures on a failed gate", () => {
    const result = runGateFromDataset([{ id: "a", attempts: { n: 2, c: 0 } }], {
      k: 1,
      thresholds: { minPassHatK: 0.9 },
    });
    expect(formatGateReport(result)).toMatch(/GATE FAIL/);
  });
});
