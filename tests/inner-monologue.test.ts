/**
 * Tests for agent-sdk/src/orchestration/ooda/inner-monologue.ts
 *
 * Coverage:
 *   SensitiveValue — reveal() returns inner value, toString() throws,
 *                    toJSON() throws (JSON.stringify safe), label accessor
 *   innerMonologue — wraps reasoning in SensitiveValue, passes through insights+confidence
 *
 * Ref: test coverage for agent-sdk/orchestration/ooda/inner-monologue.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { SensitiveValue, innerMonologue } from "../src/orchestration/ooda/inner-monologue.js";

// ─── SensitiveValue ───────────────────────────────────────────────────────────

describe("SensitiveValue", () => {
  it("reveal() returns the inner value", () => {
    const sv = new SensitiveValue("secret reasoning", "test");
    expect(sv.reveal()).toBe("secret reasoning");
  });

  it("label accessor returns the constructor label", () => {
    const sv = new SensitiveValue(42, "my-label");
    expect(sv.label).toBe("my-label");
  });

  it("default label is 'sensitive' when not provided", () => {
    const sv = new SensitiveValue("x");
    expect(sv.label).toBe("sensitive");
  });

  it("toString() throws to prevent accidental leakage", () => {
    const sv = new SensitiveValue("secret");
    expect(() => sv.toString()).toThrow("reveal()");
    expect(() => sv.toString()).toThrow("SensitiveValue");
  });

  it("toJSON() throws (JSON.stringify trap)", () => {
    const sv = new SensitiveValue("secret");
    expect(() => sv.toJSON()).toThrow("cannot be serialized");
  });

  it("JSON.stringify with SensitiveValue in an object throws", () => {
    const sv = new SensitiveValue("secret");
    expect(() => JSON.stringify({ reasoning: sv })).toThrow();
  });

  it("template literal with SensitiveValue throws", () => {
    const sv = new SensitiveValue("secret");
    expect(() => `${sv}`).toThrow();
  });
});

// ─── innerMonologue ───────────────────────────────────────────────────────────

describe("innerMonologue", () => {
  it("wraps reasoning in SensitiveValue", async () => {
    const result = await innerMonologue({ observation: "markets volatile" }, async () => ({
      reasoning: "NQ might drop 50pts given SPX divergence",
      insights: ["divergence detected"],
      confidence: 0.75,
    }));
    expect(result.reasoning).toBeInstanceOf(SensitiveValue);
    expect(result.reasoning.reveal()).toBe("NQ might drop 50pts given SPX divergence");
  });

  it("passes through insights unchanged", async () => {
    const result = await innerMonologue({ observation: {} }, async () => ({
      reasoning: "some thought",
      insights: ["insight-1", "insight-2"],
      confidence: 0.5,
    }));
    expect(result.insights).toEqual(["insight-1", "insight-2"]);
  });

  it("passes through confidence unchanged", async () => {
    const result = await innerMonologue({ observation: {} }, async () => ({
      reasoning: "thought",
      insights: [],
      confidence: 0.92,
    }));
    expect(result.confidence).toBe(0.92);
  });

  it("reasoning label is 'inner-monologue'", async () => {
    const result = await innerMonologue({ observation: {} }, async () => ({
      reasoning: "r",
      insights: [],
      confidence: 0.5,
    }));
    expect(result.reasoning.label).toBe("inner-monologue");
  });

  it("propagates reasoner rejection", async () => {
    await expect(
      innerMonologue({ observation: {} }, async () => {
        throw new Error("reasoner error");
      }),
    ).rejects.toThrow("reasoner error");
  });
});
