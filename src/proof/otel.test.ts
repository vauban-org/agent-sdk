import { deriveConeGrade, deriveStepGrade } from "@vauban-org/assurance-grade";
import { beforeAll, describe, expect, it } from "vitest";
import { setAssuranceGradingEngine, toOtelSpan } from "./otel.js";
import type { RunStep } from "./types.js";

// Chemin PRÉSENT : le moteur est injecté explicitement, comme le ferait un
// hôte in-workspace au bootstrap. Le chemin absent vit dans
// tests/proof-otel-unavailable.test.ts (aucune injection).
beforeAll(() => {
  setAssuranceGradingEngine({ deriveStepGrade, deriveConeGrade });
});

function baseStep(over: Partial<RunStep>): RunStep {
  return {
    id: "s1",
    run_id: "r1",
    step_index: 0,
    type: "decision",
    status: "done",
    started_at: "2026-06-12T00:00:00Z",
    ...over,
  } as RunStep;
}

describe("toOtelSpan assurance grade", () => {
  it("committed leaf -> A1", () => {
    const span = toOtelSpan(baseStep({ leaf_hash_poseidon: "0xabc" }));
    expect(span.attributes["vauban.assurance.grade"]).toBe("A1");
  });
  it("no evidence -> A0", () => {
    const span = toOtelSpan(baseStep({}));
    expect(span.attributes["vauban.assurance.grade"]).toBe("A0");
  });
});

describe("toOtelSpan cone_min aggregate (backward-cone weakest link)", () => {
  it("does not set cone_min when no step set is provided (per-step only)", () => {
    const span = toOtelSpan(baseStep({ id: "a", leaf_hash_poseidon: "0x1" }));
    expect(span.attributes["vauban.assurance.cone_min"]).toBeUndefined();
  });

  it("sets cone_min to the weakest grade across the backward cone", () => {
    // root span "a" depends on "b" (A1) and "c" (NO evidence => A0).
    const steps = [
      baseStep({ id: "a", parent_step_id: "b", leaf_hash_poseidon: "0x1" }),
      baseStep({ id: "b", parent_step_id: "c", mcp_call_hash: "0x2" }),
      baseStep({ id: "c", parent_step_id: null }),
    ];
    const root = steps[0];
    const span = toOtelSpan(root, steps);
    // The root's own per-step grade is A1...
    expect(span.attributes["vauban.assurance.grade"]).toBe("A1");
    // ...but the cone aggregate is floored to A0 by ancestor "c".
    expect(span.attributes["vauban.assurance.cone_min"]).toBe("A0");
  });

  it("cone_min equals A1 for a fully-evidenced cone", () => {
    const steps = [
      baseStep({ id: "a", parent_step_id: "b", leaf_hash_poseidon: "0x1" }),
      baseStep({ id: "b", parent_step_id: null, retrieval_proof_hash: "0x2" }),
    ];
    const span = toOtelSpan(steps[0], steps);
    expect(span.attributes["vauban.assurance.cone_min"]).toBe("A1");
  });
});
