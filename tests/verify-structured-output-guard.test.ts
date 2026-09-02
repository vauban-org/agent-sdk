/**
 * tests/verify-structured-output-guard.test.ts
 *
 * StructuredOutputGuard ; the schema-validation lens. Deterministic, no LLM.
 * Verifies the 1 / 0.5 / 0 scale, the lens shape, and end-to-end behaviour as a
 * hard battery lens (rejected output killed; pristine ranked above repaired).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runVerifierBattery } from "../src/compute/battery/battery.js";
import type { RunVerifierBatteryOptions } from "../src/compute/battery/types.js";
import { RecordedClock } from "../src/replay/clock.js";
import {
  guardStructuredOutput,
  structuredOutputGuard,
} from "../src/verify/structured-output-guard.js";

const schema = z.object({ intent: z.string(), qty: z.number() });

const PRISTINE = JSON.stringify({ intent: "buy", qty: 5 });
const FENCED = ["```json", JSON.stringify({ intent: "sell", qty: 3 }), "```"].join("\n");
const WRONG_SCHEMA = JSON.stringify({ intent: "buy", qty: "five" });
const GARBAGE = "i think the answer is to buy five units";

function opts(over: Partial<RunVerifierBatteryOptions> = {}): RunVerifierBatteryOptions {
  return {
    clock: new RecordedClock([1_700_000_000_000, 1_700_000_000_050]),
    runId: "guard-run-001",
    adrEco: "ADR-ECO-045",
    ...over,
  };
}

describe("guardStructuredOutput", () => {
  it("scores pristine JSON 1.0 and returns the parsed value", () => {
    const v = guardStructuredOutput(schema, PRISTINE);
    expect(v.score).toBe(1);
    expect(v.repaired).toBe(false);
    expect(v.value).toEqual({ intent: "buy", qty: 5 });
  });

  it("scores fence-wrapped JSON 0.5 (repaired) and recovers the value", () => {
    const v = guardStructuredOutput(schema, FENCED);
    expect(v.score).toBe(0.5);
    expect(v.repaired).toBe(true);
    expect(v.value).toEqual({ intent: "sell", qty: 3 });
  });

  it("scores schema-invalid JSON 0.0 with a null value", () => {
    const v = guardStructuredOutput(schema, WRONG_SCHEMA);
    expect(v.score).toBe(0);
    expect(v.value).toBeNull();
    expect(v.rationale).toMatch(/^rejected:/);
  });

  it("scores non-JSON 0.0", () => {
    const v = guardStructuredOutput(schema, GARBAGE);
    expect(v.score).toBe(0);
    expect(v.value).toBeNull();
  });
});

describe("structuredOutputGuard (lens)", () => {
  it("builds a hard affirm rule lens", () => {
    const lens = structuredOutputGuard(schema);
    expect(lens.verifier.name).toBe("structured-output-guard");
    expect(lens.polarity).toBe("affirm");
    expect(lens.criticality).toBe("hard");
    expect(lens.signature.engine).toBe("rule");
  });

  it("the verifier scores via guardStructuredOutput", async () => {
    const lens = structuredOutputGuard(schema);
    expect(await lens.verifier.evaluate(PRISTINE)).toMatchObject({ score: 1 });
    expect(await lens.verifier.evaluate(GARBAGE)).toMatchObject({ score: 0 });
  });

  it("honours a soft criticality override", () => {
    const lens = structuredOutputGuard(schema, {
      criticality: "soft",
      name: "soft-guard",
    });
    expect(lens.criticality).toBe("soft");
    expect(lens.verifier.name).toBe("soft-guard");
  });
});

describe("structuredOutputGuard in a battery", () => {
  it("kills unparseable output and ranks pristine above repaired", async () => {
    const candidates = [PRISTINE, FENCED, GARBAGE];
    const d = await runVerifierBattery<string>(
      "produce an order",
      candidates,
      [structuredOutputGuard(schema)],
      opts(),
    );

    // GARBAGE (0.0) killed by the hard guard; PRISTINE (1.0) beats FENCED (0.5).
    expect(d.acceptedIndex).toBe(0);
    expect(d.accepted).toBe(PRISTINE);
    expect(d.verdicts[2].killed).toBe(true);

    const garbageReject = d.rejected.find((r) => r.candidateIndex === 2);
    expect(garbageReject?.reason).toMatch(/^killed:/);
    const fencedReject = d.rejected.find((r) => r.candidateIndex === 1);
    expect(fencedReject?.reason).toMatch(/^not-selected:/);
  });

  it("a battery of guard-only over all-invalid candidates fails closed", async () => {
    const d = await runVerifierBattery<string>(
      "produce an order",
      [GARBAGE, WRONG_SCHEMA],
      [structuredOutputGuard(schema)],
      opts(),
    );
    expect(d.accepted).toBeNull();
    expect(d.acceptedIndex).toBeNull();
    expect(d.rejected).toHaveLength(2);
  });
});
