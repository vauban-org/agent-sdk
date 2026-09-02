/**
 * Tests for persona-schema.ts + escalation-mapping.ts
 *
 * Coverage (persona-schema):
 *   validatePersona — empty object passes (all fields optional),
 *                     invalid tone rejected, full persona validates
 *   mergePersona — local wins over base field-by-field,
 *                  arrays replaced by local (not merged),
 *                  base kept when local field is absent
 *   DEFAULT_PERSONA — correct default values
 *
 * Coverage (escalation-mapping):
 *   toSdkEscalationLevel — L0→L1_autonomous, L1→L1_autonomous,
 *                           L2→L2_async_review, L3→L3_hitl_required
 *
 * Ref: test coverage for persona-schema.ts + escalation-mapping.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, mergePersona, validatePersona } from "../src/identity/persona-schema.js";
import { toSdkEscalationLevel } from "../src/types/escalation-mapping.js";

// ─── validatePersona ──────────────────────────────────────────────────────────

describe("validatePersona", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(() => validatePersona({})).not.toThrow();
  });

  it("accepts a fully specified persona", () => {
    const persona = validatePersona({
      identity: {
        name: "Forge",
        role: "agent",
        tone: "concise",
        formality: "technical",
        language: "en",
      },
      traits: ["analytical"],
      domain_expertise: ["finance", "ZK"],
      communication: {
        explain_reasoning: "on_error",
        acknowledgment_style: "minimal",
      },
    });
    expect(persona.identity?.name).toBe("Forge");
  });

  it("throws for invalid tone value", () => {
    expect(() => validatePersona({ identity: { tone: "aggressive" } })).toThrow();
  });

  it("throws for invalid formality value", () => {
    expect(() => validatePersona({ identity: { formality: "rude" } })).toThrow();
  });
});

// ─── DEFAULT_PERSONA ──────────────────────────────────────────────────────────

describe("DEFAULT_PERSONA", () => {
  it("has identity.tone = 'concise'", () => {
    expect(DEFAULT_PERSONA.identity?.tone).toBe("concise");
  });

  it("has identity.formality = 'technical'", () => {
    expect(DEFAULT_PERSONA.identity?.formality).toBe("technical");
  });

  it("has explain_reasoning = 'on_error'", () => {
    expect(DEFAULT_PERSONA.communication?.explain_reasoning).toBe("on_error");
  });

  it("has acknowledgment_style = 'minimal'", () => {
    expect(DEFAULT_PERSONA.communication?.acknowledgment_style).toBe("minimal");
  });
});

// ─── mergePersona ─────────────────────────────────────────────────────────────

describe("mergePersona", () => {
  const base = {
    identity: { name: "Forge", tone: "concise" as const },
    traits: ["analytical"],
    domain_expertise: ["finance"],
    communication: {
      explain_reasoning: "on_error" as const,
      acknowledgment_style: "minimal" as const,
    },
  };

  it("local identity fields override base fields", () => {
    const result = mergePersona(base, {
      identity: { tone: "detailed" as const },
    });
    expect(result.identity?.tone).toBe("detailed");
    expect(result.identity?.name).toBe("Forge"); // from base
  });

  it("local traits array replaces base traits entirely", () => {
    const result = mergePersona(base, {
      traits: ["creative"],
    });
    expect(result.traits).toEqual(["creative"]);
  });

  it("base traits kept when local traits is undefined", () => {
    const result = mergePersona(base, { identity: { name: "New" } });
    expect(result.traits).toEqual(["analytical"]);
  });

  it("local domain_expertise replaces base domain_expertise", () => {
    const result = mergePersona(base, { domain_expertise: ["ZK", "crypto"] });
    expect(result.domain_expertise).toEqual(["ZK", "crypto"]);
  });

  it("local communication fields win over base", () => {
    const result = mergePersona(base, {
      communication: { explain_reasoning: "always" as const },
    });
    expect(result.communication?.explain_reasoning).toBe("always");
    expect(result.communication?.acknowledgment_style).toBe("minimal"); // base
  });
});

// ─── toSdkEscalationLevel ─────────────────────────────────────────────────────

describe("toSdkEscalationLevel", () => {
  it("L0 → L1_autonomous", () => {
    expect(toSdkEscalationLevel("L0")).toBe("L1_autonomous");
  });

  it("L1 → L1_autonomous (both L0 and L1 map to autonomous)", () => {
    expect(toSdkEscalationLevel("L1")).toBe("L1_autonomous");
  });

  it("L2 → L2_async_review", () => {
    expect(toSdkEscalationLevel("L2")).toBe("L2_async_review");
  });

  it("L3 → L3_hitl_required", () => {
    expect(toSdkEscalationLevel("L3")).toBe("L3_hitl_required");
  });
});
