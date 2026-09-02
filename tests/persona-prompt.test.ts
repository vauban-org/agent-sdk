/**
 * Tests for src/identity/persona-prompt.ts — buildPersonaPromptBlock
 *
 * Coverage:
 *   empty persona → returns ''
 *   identity.name → 'You are <name>.'
 *   identity.role → 'Role: <role>.'
 *   identity.tone + formality → 'Communication style: tone, formality.'
 *   identity.language !== 'en' → 'Respond in <lang>.'
 *   identity.language = 'en' → no language line
 *   traits → 'Traits: a, b.'
 *   domain_expertise → 'Domain expertise: x, y.'
 *   communication.max_response_length → 'Keep responses under N characters.'
 *   communication.explain_reasoning='always' → step-by-step line
 *   communication.explain_reasoning='never' → emit results only line
 *   communication.acknowledgment_style='none' → no preamble line
 *   communication.acknowledgment_style='minimal' → go directly line
 *   communication.use_analogies=false → no analogies line
 *   output is bounded by --- persona --- / --- end persona --- markers
 *
 * Ref: test coverage for src/identity/persona-prompt.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { buildPersonaPromptBlock } from "../src/identity/persona-prompt.js";

// ─── Empty persona ────────────────────────────────────────────────────────────

describe("buildPersonaPromptBlock — empty persona", () => {
  it("returns empty string for persona with no fields", () => {
    expect(buildPersonaPromptBlock({})).toBe("");
  });

  it("returns empty string for persona with only empty arrays", () => {
    expect(buildPersonaPromptBlock({ traits: [], domain_expertise: [] })).toBe("");
  });
});

// ─── Identity fields ──────────────────────────────────────────────────────────

describe("buildPersonaPromptBlock — identity", () => {
  it("includes 'You are <name>.' when name is set", () => {
    const result = buildPersonaPromptBlock({ identity: { name: "Aria" } });
    expect(result).toContain("You are Aria.");
  });

  it("includes 'Role: <role>.' when role is set", () => {
    const result = buildPersonaPromptBlock({
      identity: { role: "Senior Security Auditor" },
    });
    expect(result).toContain("Role: Senior Security Auditor.");
  });

  it("includes tone in communication style line", () => {
    const result = buildPersonaPromptBlock({
      identity: { tone: "concise", formality: "formal" },
    });
    expect(result).toContain("Communication style: concise, formal.");
  });

  it("tone only — no formality", () => {
    const result = buildPersonaPromptBlock({ identity: { tone: "casual" } });
    expect(result).toContain("Communication style: casual.");
  });

  it("emits 'Respond in <lang>.' for non-English language", () => {
    const result = buildPersonaPromptBlock({
      identity: { language: "fr", name: "x" },
    });
    expect(result).toContain("Respond in fr.");
  });

  it("does NOT emit language line when language is 'en'", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot", language: "en" },
    });
    expect(result).not.toContain("Respond in");
  });
});

// ─── Traits and domain expertise ─────────────────────────────────────────────

describe("buildPersonaPromptBlock — traits + domain_expertise", () => {
  it("includes 'Traits:' line", () => {
    const result = buildPersonaPromptBlock({ traits: ["analytical", "terse"] });
    expect(result).toContain("Traits: analytical, terse.");
  });

  it("omits Traits line when array is empty", () => {
    const result = buildPersonaPromptBlock({
      traits: [],
      identity: { name: "Bot" },
    });
    expect(result).not.toContain("Traits:");
  });

  it("includes 'Domain expertise:' line", () => {
    const result = buildPersonaPromptBlock({
      domain_expertise: ["ZK proofs", "Cairo"],
    });
    expect(result).toContain("Domain expertise: ZK proofs, Cairo.");
  });
});

// ─── Communication fields ─────────────────────────────────────────────────────

describe("buildPersonaPromptBlock — communication", () => {
  it("includes max_response_length line", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { max_response_length: 500 },
    });
    expect(result).toContain("Keep responses under 500 characters.");
  });

  it("explain_reasoning='always' → step-by-step line", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { explain_reasoning: "always" },
    });
    expect(result).toContain("step by step");
  });

  it("explain_reasoning='never' → emit results only", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { explain_reasoning: "never" },
    });
    expect(result).toContain("results only");
  });

  it("acknowledgment_style='none' → skip preamble line", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { acknowledgment_style: "none" },
    });
    expect(result).toContain("preamble");
  });

  it("acknowledgment_style='minimal' → go directly line", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { acknowledgment_style: "minimal" },
    });
    expect(result).toContain("directly to output");
  });

  it("use_analogies=false → no analogies line", () => {
    const result = buildPersonaPromptBlock({
      identity: { name: "Bot" },
      communication: { use_analogies: false },
    });
    expect(result).toContain("Do not use analogies.");
  });
});

// ─── Block structure ──────────────────────────────────────────────────────────

describe("buildPersonaPromptBlock — block structure", () => {
  it("starts with blank line followed by --- persona --- marker", () => {
    const result = buildPersonaPromptBlock({ identity: { name: "Bot" } });
    expect(result).toMatch(/^\n--- persona ---/);
  });

  it("ends with --- end persona --- marker", () => {
    const result = buildPersonaPromptBlock({ identity: { name: "Bot" } });
    expect(result).toMatch(/--- end persona ---$/);
  });
});
