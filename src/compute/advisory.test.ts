/**
 * AdvisoryClaim ; I2 type-boundary contract (ADR-ECO-101).
 *
 * The generic primitive contract: a branded advisory is recognised by the guard,
 * carries its provenance, and is FORBIDDEN BY TYPE from a deterministic gate
 * signature (compile-time @ts-expect-error + the runtime backstop). The pilot's
 * I5 / ORIENT integration tests live with their consumer (the BTC pilot).
 */

import { describe, expect, it } from "vitest";
import { type AdvisoryClaim, advisoryClaim, assertNotAdvisory, isAdvisory } from "./advisory.js";

describe("advisoryClaim + isAdvisory", () => {
  it("constructs a branded advisory and the guard recognises it", () => {
    const a = advisoryClaim("risk-on note", { source: "llm", confidence: 0.5 });
    expect(a.kind).toBe("advisory");
    expect(a.value).toBe("risk-on note");
    expect(isAdvisory(a)).toBe(true);
  });

  it("carries provenance verbatim", () => {
    const a = advisoryClaim(42, {
      source: "ml-model",
      model: "xgboost",
      version: "1.2.0",
      confidence: 0.8,
    });
    expect(a.provenance).toEqual({
      source: "ml-model",
      model: "xgboost",
      version: "1.2.0",
      confidence: 0.8,
    });
  });

  it("the guard rejects plain data and non-objects", () => {
    expect(isAdvisory({ kind: "hold" })).toBe(false);
    expect(isAdvisory({ regime: "neutral" })).toBe(false);
    expect(isAdvisory(null)).toBe(false);
    expect(isAdvisory("advisory")).toBe(false);
  });
});

describe("assertNotAdvisory ; runtime backstop", () => {
  it("throws on an advisory, passes plain data", () => {
    const a = advisoryClaim("x", { source: "llm", confidence: 0.5 });
    expect(() => assertNotAdvisory(a, "gate")).toThrow(TypeError);
    expect(() => assertNotAdvisory({ kind: "hold" }, "gate")).not.toThrow();
  });
});

describe("type wall ; an AdvisoryClaim cannot reach a deterministic gate", () => {
  interface Decision {
    readonly kind: "hold" | "act";
  }
  function deterministicGate(decision: Decision): string {
    assertNotAdvisory(decision, "deterministicGate");
    return decision.kind;
  }

  it("rejects an AdvisoryClaim at compile time and at runtime", () => {
    const a: AdvisoryClaim<string> = advisoryClaim("x", {
      source: "llm",
      confidence: 0.5,
    });
    const callGate = () =>
      // @ts-expect-error AdvisoryClaim is not a Decision ; the I2 type wall.
      deterministicGate(a);
    expect(callGate).toThrow(TypeError); // runtime backstop also rejects it
    expect(deterministicGate({ kind: "hold" })).toBe("hold");
  });
});
