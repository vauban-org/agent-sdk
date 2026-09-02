/**
 * buildPersonaPromptBlock tests — W1.3 (CC v3.1 sprint-562).
 *
 * Covers:
 *   - empty string when persona has no actionable fields
 *   - name + role emitted correctly
 *   - tone + formality merged into style line
 *   - non-English language line emitted
 *   - English language NOT emitted (default, no noise)
 *   - traits list emitted
 *   - domain_expertise list emitted
 *   - max_response_length emitted
 *   - explain_reasoning: always / never variants
 *   - acknowledgment_style: none / minimal variants
 *   - use_analogies: false emitted
 *   - DEFAULT_PERSONA produces a non-empty block
 *   - block bounded by persona markers
 */

import { describe, expect, it } from "vitest";
import { buildPersonaPromptBlock } from "../../src/identity/persona-prompt.js";
import { DEFAULT_PERSONA } from "../../src/identity/persona-schema.js";
import type { AgentPersona } from "../../src/identity/persona-schema.js";

describe("buildPersonaPromptBlock", () => {
  it("returns empty string for fully empty persona", () => {
    const persona: AgentPersona = {};
    expect(buildPersonaPromptBlock(persona)).toBe("");
  });

  it("returns empty string when all sub-objects are present but empty", () => {
    const persona: AgentPersona = {
      identity: {},
      traits: [],
      domain_expertise: [],
      communication: {},
    };
    expect(buildPersonaPromptBlock(persona)).toBe("");
  });

  it("includes name line when identity.name set", () => {
    const persona: AgentPersona = { identity: { name: "ARCHITECT" } };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("You are ARCHITECT.");
  });

  it("includes role line when identity.role set", () => {
    const persona: AgentPersona = {
      identity: { role: "Senior TypeScript engineer" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Role: Senior TypeScript engineer.");
  });

  it("merges tone and formality into single style line", () => {
    const persona: AgentPersona = {
      identity: { tone: "concise", formality: "technical" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Communication style: concise, technical.");
  });

  it("omits style line when neither tone nor formality set", () => {
    const persona: AgentPersona = { identity: { name: "X" } };
    expect(buildPersonaPromptBlock(persona)).not.toContain("Communication style");
  });

  it("emits language line when language is non-English", () => {
    const persona: AgentPersona = { identity: { language: "fr-FR" } };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Respond in fr-FR.");
  });

  it("does NOT emit language line for default English", () => {
    const persona: AgentPersona = { identity: { language: "en" } };
    expect(buildPersonaPromptBlock(persona)).not.toContain("Respond in");
  });

  it("includes traits list", () => {
    const persona: AgentPersona = {
      traits: ["pragmatic", "security-minded"],
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Traits: pragmatic, security-minded.");
  });

  it("skips traits line for empty array", () => {
    const persona: AgentPersona = { traits: [] };
    expect(buildPersonaPromptBlock(persona)).toBe("");
  });

  it("includes domain_expertise list", () => {
    const persona: AgentPersona = {
      domain_expertise: ["Cairo", "Starknet", "TypeScript"],
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Domain expertise: Cairo, Starknet, TypeScript.");
  });

  it("includes max_response_length constraint", () => {
    const persona: AgentPersona = {
      communication: { max_response_length: 2000 },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Keep responses under 2000 characters.");
  });

  it("explain_reasoning=always emits step-by-step instruction", () => {
    const persona: AgentPersona = {
      communication: { explain_reasoning: "always" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Always explain your reasoning step by step.");
  });

  it("explain_reasoning=never emits results-only instruction", () => {
    const persona: AgentPersona = {
      communication: { explain_reasoning: "never" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Do not explain your reasoning.");
  });

  it("explain_reasoning=on_error emits nothing extra", () => {
    const persona: AgentPersona = {
      communication: { explain_reasoning: "on_error" },
    };
    // on_error is the default — no explicit instruction needed
    expect(buildPersonaPromptBlock(persona)).toBe("");
  });

  it("acknowledgment_style=none emits no-preamble instruction", () => {
    const persona: AgentPersona = {
      communication: { acknowledgment_style: "none" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Do not acknowledge the task.");
  });

  it("acknowledgment_style=minimal emits skip-preamble instruction", () => {
    const persona: AgentPersona = {
      communication: { acknowledgment_style: "minimal" },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Skip task acknowledgment preamble.");
  });

  it("use_analogies=false emits no-analogies instruction", () => {
    const persona: AgentPersona = {
      communication: { use_analogies: false },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Do not use analogies.");
  });

  it("DEFAULT_PERSONA produces a non-empty block", () => {
    const block = buildPersonaPromptBlock(DEFAULT_PERSONA);
    expect(block.length).toBeGreaterThan(10);
  });

  it("block is bounded by persona markers", () => {
    const persona: AgentPersona = { identity: { name: "BUILDER" } };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("--- persona ---");
    expect(block).toContain("--- end persona ---");
    const start = block.indexOf("--- persona ---");
    const end = block.indexOf("--- end persona ---");
    expect(start).toBeLessThan(end);
  });

  it("starts with newline for safe concatenation", () => {
    const persona: AgentPersona = { identity: { name: "TESTER" } };
    expect(buildPersonaPromptBlock(persona).startsWith("\n")).toBe(true);
  });

  // ─── SDK 1.12 additive sections ────────────────────────────────────────

  it("emits directives.must as bulleted MUST list", () => {
    const persona: AgentPersona = {
      directives: { must: ["Cite the spec", "Use real handles only"] },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Mandatory rules (MUST):");
    expect(block).toContain("  - Cite the spec");
    expect(block).toContain("  - Use real handles only");
  });

  it("emits directives.must_not as bulleted MUST NOT list", () => {
    const persona: AgentPersona = {
      directives: { must_not: ["Use em-dashes", "Reveal contract addresses"] },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Forbidden behaviors (MUST NOT):");
    expect(block).toContain("  - Use em-dashes");
    expect(block).toContain("  - Reveal contract addresses");
  });

  it("omits directives section when both lists are empty", () => {
    const persona: AgentPersona = { directives: { must: [], must_not: [] } };
    expect(buildPersonaPromptBlock(persona)).toBe("");
  });

  it("emits whitelist hashtags and mentions", () => {
    const persona: AgentPersona = {
      whitelist: {
        hashtags: ["#ZK", "#Starknet"],
        mentions: ["@Starknet", "@starkware"],
      },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Whitelist (only emit items from these lists):");
    expect(block).toContain("Hashtags: #ZK, #Starknet");
    expect(block).toContain("Mentions: @Starknet, @starkware");
  });

  it("emits forbidden_patterns with scope label", () => {
    const persona: AgentPersona = {
      forbidden_patterns: [
        {
          name: "contract_address",
          pattern: "0x[a-fA-F0-9]{60,64}",
          scope: "public_marketing",
        },
      ],
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Forbidden patterns (DO NOT emit");
    expect(block).toContain("contract_address [scope: public_marketing]: 0x[a-fA-F0-9]{60,64}");
  });

  it("emits output_contracts per action_type", () => {
    const persona: AgentPersona = {
      output_contracts: {
        publish_social_post: {
          description: "X thread JSON",
          schema_hint: '{ "tweets": string[], "platform": "x" }',
        },
        publish_article: {
          description: "Rempart article",
        },
      },
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Output contracts by action_type:");
    expect(block).toContain("publish_social_post — X thread JSON");
    expect(block).toContain('Expected shape: { "tweets": string[]');
    expect(block).toContain("publish_article — Rempart article");
  });

  it("emits BAD/GOOD examples", () => {
    const persona: AgentPersona = {
      examples: [
        {
          situation: "Closing a thread",
          bad: "This is just the beginning.",
          good: "DM us if you operate a Starknet protocol.",
        },
      ],
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Examples (BAD vs GOOD):");
    expect(block).toContain("Situation: Closing a thread");
    expect(block).toContain("BAD: This is just the beginning.");
    expect(block).toContain("GOOD: DM us if you operate a Starknet protocol.");
  });

  it("appends extra_instructions raw block", () => {
    const persona: AgentPersona = {
      extra_instructions: "## IP discipline\nNever expose audit firm names.",
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("Additional instructions:");
    expect(block).toContain("## IP discipline");
    expect(block).toContain("Never expose audit firm names.");
  });

  it("composes all new sections in a single block", () => {
    const persona: AgentPersona = {
      identity: { name: "Vauban Marketing", role: "GTM voice" },
      directives: { must: ["Use numbers"], must_not: ["Use em-dashes"] },
      whitelist: { hashtags: ["#ZK"], mentions: ["@Starknet"] },
      forbidden_patterns: [{ name: "audit_firm", pattern: "trailofbits|zellic" }],
      output_contracts: { post: { description: "X thread" } },
      examples: [{ situation: "Hook", good: "Most projects ship 5 countries. We shipped 33." }],
      extra_instructions: "Stay under 280 chars per tweet.",
    };
    const block = buildPersonaPromptBlock(persona);
    // every section header present
    expect(block).toContain("You are Vauban Marketing.");
    expect(block).toContain("Mandatory rules (MUST):");
    expect(block).toContain("Forbidden behaviors (MUST NOT):");
    expect(block).toContain("Whitelist");
    expect(block).toContain("Forbidden patterns");
    expect(block).toContain("Output contracts");
    expect(block).toContain("Examples (BAD vs GOOD):");
    expect(block).toContain("Additional instructions:");
    // bounded
    expect(block).toContain("--- persona ---");
    expect(block).toContain("--- end persona ---");
  });

  it("backwards-compat: persona without any new fields renders unchanged", () => {
    const persona: AgentPersona = {
      identity: { name: "Legacy", tone: "concise", formality: "technical" },
      traits: ["pragmatic"],
    };
    const block = buildPersonaPromptBlock(persona);
    expect(block).toContain("You are Legacy.");
    expect(block).toContain("Communication style: concise, technical.");
    expect(block).toContain("Traits: pragmatic.");
    // none of the new section headers
    expect(block).not.toContain("MUST");
    expect(block).not.toContain("Whitelist");
    expect(block).not.toContain("Forbidden patterns");
    expect(block).not.toContain("Output contracts");
    expect(block).not.toContain("Examples (BAD");
    expect(block).not.toContain("Additional instructions");
  });
});
