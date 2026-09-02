/**
 * Tests for AgentPersona — schema, merge, Brain, file, resolution.
 *
 * Coverage:
 *   - Schema validation: nominal, invalid enums, unknown keys
 *   - mergePersona: identity merge, communication merge, array override
 *   - savePersonaToBrain + loadPersonaFromBrain round-trip
 *   - File: load missing, load malformed, save + reload
 *   - resolvePersona: defaults only / +brain / +brain+local layering
 *
 * @see ../../src/identity/persona-schema.ts
 * @see ../../src/identity/agent-persona.ts
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERSONA_BRAIN_CATEGORY,
  loadPersonaFromBrain,
  loadPersonaFromFile,
  personaTags,
  resolvePersona,
  savePersonaToBrain,
  savePersonaToFile,
} from "../../src/identity/agent-persona.js";
import {
  type AgentPersona,
  DEFAULT_PERSONA,
  PersonaSchema,
  mergePersona,
  validatePersona,
} from "../../src/identity/persona-schema.js";
import { InMemorySemanticMemory } from "../../src/ports/brain.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("PersonaSchema", () => {
  it("accepts a fully-populated persona", () => {
    const p: AgentPersona = {
      identity: {
        name: "Atlas",
        role: "Senior Infrastructure Engineer",
        tone: "concise",
        formality: "formal",
        language: "fr",
      },
      traits: ["direct", "skeptical", "pragmatic"],
      domain_expertise: ["blockchain/starknet", "kubernetes"],
      communication: {
        max_response_length: 500,
        use_analogies: true,
        explain_reasoning: "always",
        acknowledgment_style: "minimal",
      },
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("accepts an empty persona", () => {
    expect(validatePersona({})).toEqual({});
  });

  it("rejects invalid tone enum", () => {
    expect(() => validatePersona({ identity: { tone: "monotonous" } })).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => validatePersona({ identity: { name: "x" }, foo: "bar" })).toThrow();
  });

  it("rejects unknown identity keys", () => {
    expect(() => validatePersona({ identity: { surname: "x" } as unknown })).toThrow();
  });

  it("rejects max_response_length <= 0", () => {
    expect(() => validatePersona({ communication: { max_response_length: 0 } })).toThrow();
  });

  it("rejects traits with >16 entries", () => {
    expect(() =>
      validatePersona({
        traits: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }),
    ).toThrow();
  });

  it("rejects empty trait string", () => {
    expect(() => validatePersona({ traits: [""] })).toThrow();
  });

  // ─── SDK 1.12 additive fields ────────────────────────────────────────────

  it("accepts persona with directives.must + must_not", () => {
    const p: AgentPersona = {
      directives: {
        must: ["Cite the spec", "Use real handles"],
        must_not: ["Use em-dashes"],
      },
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("rejects directives.must with >32 entries", () => {
    expect(() =>
      validatePersona({
        directives: {
          must: Array.from({ length: 33 }, (_, i) => `rule ${i}`),
        },
      }),
    ).toThrow();
  });

  it("accepts forbidden_patterns array with scope", () => {
    const p: AgentPersona = {
      forbidden_patterns: [
        { name: "contract_address", pattern: "0x[a-f0-9]+", scope: "public" },
        { name: "audit_firm", pattern: "trailofbits|zellic" },
      ],
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("rejects forbidden_patterns entry without name", () => {
    expect(() =>
      validatePersona({
        forbidden_patterns: [{ pattern: "x" } as unknown as { name: string; pattern: string }],
      }),
    ).toThrow();
  });

  it("accepts whitelist with hashtags + mentions", () => {
    const p: AgentPersona = {
      whitelist: {
        hashtags: ["#ZK", "#Starknet"],
        mentions: ["@Starknet", "@starkware"],
      },
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("accepts examples with situation + bad + good", () => {
    const p: AgentPersona = {
      examples: [
        {
          situation: "Hook tweet",
          bad: "This is just the beginning.",
          good: "Most projects ship 5. We shipped 33.",
        },
      ],
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("accepts output_contracts record keyed by action_type", () => {
    const p: AgentPersona = {
      output_contracts: {
        publish_social_post: { description: "X thread", schema_hint: "{tweets:[]}" },
        publish_article: { description: "Rempart article" },
      },
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("accepts extra_instructions markdown overflow", () => {
    const p: AgentPersona = {
      extra_instructions: "## IP discipline\n- Never reveal contract addresses.",
    };
    expect(validatePersona(p)).toEqual(p);
  });

  it("rejects extra_instructions over 16KB", () => {
    expect(() =>
      validatePersona({
        extra_instructions: "x".repeat(16_385),
      }),
    ).toThrow();
  });

  it("mergePersona handles directives override (local wins)", () => {
    const base: AgentPersona = {
      directives: { must: ["a"], must_not: ["x"] },
    };
    const local: AgentPersona = {
      directives: { must: ["b"] },
    };
    const merged = mergePersona(base, local);
    expect(merged.directives?.must).toEqual(["b"]);
    expect(merged.directives?.must_not).toEqual(["x"]);
  });

  it("mergePersona shallow-merges output_contracts by key", () => {
    const base: AgentPersona = {
      output_contracts: {
        a: { description: "A base" },
        b: { description: "B base" },
      },
    };
    const local: AgentPersona = {
      output_contracts: {
        b: { description: "B local" },
        c: { description: "C local" },
      },
    };
    const merged = mergePersona(base, local);
    expect(merged.output_contracts?.a?.description).toBe("A base");
    expect(merged.output_contracts?.b?.description).toBe("B local");
    expect(merged.output_contracts?.c?.description).toBe("C local");
  });

  it("mergePersona preserves new fields from base when local omits them", () => {
    const base: AgentPersona = {
      whitelist: { hashtags: ["#ZK"] },
      examples: [{ situation: "x" }],
      extra_instructions: "rules",
    };
    const local: AgentPersona = { identity: { tone: "concise" } };
    const merged = mergePersona(base, local);
    expect(merged.whitelist?.hashtags).toEqual(["#ZK"]);
    expect(merged.examples).toEqual([{ situation: "x" }]);
    expect(merged.extra_instructions).toBe("rules");
  });
});

// ─── Merge ───────────────────────────────────────────────────────────────────

describe("mergePersona", () => {
  it("identity merges field-by-field, local wins", () => {
    const base: AgentPersona = {
      identity: { tone: "concise", language: "en" },
    };
    const local: AgentPersona = { identity: { tone: "detailed" } };
    const merged = mergePersona(base, local);
    expect(merged.identity?.tone).toBe("detailed");
    expect(merged.identity?.language).toBe("en"); // preserved from base
  });

  it("communication merges field-by-field", () => {
    const base: AgentPersona = {
      communication: { explain_reasoning: "on_error", use_analogies: false },
    };
    const local: AgentPersona = {
      communication: { explain_reasoning: "always" },
    };
    const merged = mergePersona(base, local);
    expect(merged.communication?.explain_reasoning).toBe("always");
    expect(merged.communication?.use_analogies).toBe(false);
  });

  it("traits array REPLACES (override semantics)", () => {
    const base: AgentPersona = { traits: ["a", "b"] };
    const local: AgentPersona = { traits: ["c"] };
    expect(mergePersona(base, local).traits).toEqual(["c"]);
  });

  it("traits preserved when local omits them", () => {
    const base: AgentPersona = { traits: ["a", "b"] };
    const local: AgentPersona = {};
    expect(mergePersona(base, local).traits).toEqual(["a", "b"]);
  });

  it("domain_expertise follows the same override semantics", () => {
    const base: AgentPersona = { domain_expertise: ["x"] };
    const local: AgentPersona = { domain_expertise: ["y", "z"] };
    expect(mergePersona(base, local).domain_expertise).toEqual(["y", "z"]);
  });
});

// ─── Brain layer ─────────────────────────────────────────────────────────────

describe("Brain layer", () => {
  it("savePersonaToBrain + loadPersonaFromBrain round-trip", async () => {
    const brain = new InMemorySemanticMemory();
    const persona: AgentPersona = {
      identity: { name: "Atlas", tone: "concise" },
      traits: ["direct"],
    };
    const id = await savePersonaToBrain(brain, "ARCHITECT", persona);
    expect(id).toBeTruthy();
    const loaded = await loadPersonaFromBrain(brain, "ARCHITECT");
    expect(loaded).toEqual(persona);
  });

  it("loadPersonaFromBrain returns null when no entry exists", async () => {
    const brain = new InMemorySemanticMemory();
    const loaded = await loadPersonaFromBrain(brain, "GHOST");
    expect(loaded).toBeNull();
  });

  it("personaTags is deterministic + scopes by agent", () => {
    expect(personaTags("ARCHITECT")).toEqual(["persona", "ARCHITECT"]);
  });

  it("savePersonaToBrain validates input — rejects bad enums", async () => {
    const brain = new InMemorySemanticMemory();
    await expect(
      savePersonaToBrain(brain, "X", {
        identity: { tone: "wrong" as unknown as "concise" },
      }),
    ).rejects.toThrow();
  });

  it("Brain category is constant — agents query by it", () => {
    expect(PERSONA_BRAIN_CATEGORY).toBe("agent-persona");
  });

  it("loadPersonaFromBrain prefers the latest entry by created_at", async () => {
    const brain = new InMemorySemanticMemory();
    await savePersonaToBrain(brain, "X", { identity: { tone: "concise" } });
    // Force a slight delay so created_at differs
    await new Promise((r) => setTimeout(r, 5));
    await savePersonaToBrain(brain, "X", { identity: { tone: "detailed" } });
    const loaded = await loadPersonaFromBrain(brain, "X");
    expect(loaded?.identity?.tone).toBe("detailed");
  });
});

// ─── File layer ──────────────────────────────────────────────────────────────

describe("File layer", () => {
  it("loadPersonaFromFile returns null for missing file", async () => {
    const loaded = await loadPersonaFromFile("/no/such/persona.yaml");
    expect(loaded).toBeNull();
  });

  it("loadPersonaFromFile returns null for malformed YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "this is: not :: valid\n  - bad: yaml: triple", "utf-8");
    const loaded = await loadPersonaFromFile(path);
    expect(loaded).toBeNull();
  });

  it("loadPersonaFromFile returns null for schema-invalid YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "identity:\n  tone: yelling\n", "utf-8");
    const loaded = await loadPersonaFromFile(path);
    expect(loaded).toBeNull();
  });

  it("savePersonaToFile + loadPersonaFromFile round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    const path = join(dir, "persona.yaml");
    const persona: AgentPersona = {
      identity: { name: "Atlas", tone: "formal" as unknown as "concise" },
      traits: ["direct"],
    };
    // Fix the wrong enum cast (test sanity)
    persona.identity!.tone = "concise";
    await savePersonaToFile(path, persona);
    const loaded = await loadPersonaFromFile(path);
    expect(loaded).toEqual(persona);
  });

  it("savePersonaToFile rejects invalid persona", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    const path = join(dir, "p.yaml");
    await expect(
      savePersonaToFile(path, {
        identity: { tone: "bad" as unknown as "concise" },
      }),
    ).rejects.toThrow();
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe("resolvePersona", () => {
  it("returns defaults only when no brain + no local", async () => {
    const { effective, layers } = await resolvePersona({ agentId: "X" });
    expect(effective).toEqual(DEFAULT_PERSONA);
    expect(layers).toEqual(["defaults"]);
  });

  it("layers defaults + brain when brain has an entry", async () => {
    const brain = new InMemorySemanticMemory();
    await savePersonaToBrain(brain, "X", {
      identity: { name: "Atlas" },
      traits: ["direct"],
    });
    const { effective, layers } = await resolvePersona({
      agentId: "X",
      brain,
    });
    expect(layers).toEqual(["defaults", "brain"]);
    expect(effective.identity?.name).toBe("Atlas");
    expect(effective.identity?.tone).toBe("concise"); // from defaults
    expect(effective.traits).toEqual(["direct"]);
  });

  it("layers defaults + brain + local — local wins on conflict", async () => {
    const brain = new InMemorySemanticMemory();
    await savePersonaToBrain(brain, "X", {
      identity: { name: "Atlas", tone: "concise" },
    });

    const dir = await mkdtemp(join(tmpdir(), "persona-"));
    const localPath = join(dir, "persona.yaml");
    await savePersonaToFile(localPath, {
      identity: { tone: "detailed" },
    });

    const { effective, layers } = await resolvePersona({
      agentId: "X",
      brain,
      localPath,
    });
    expect(layers).toEqual(["defaults", "brain", "local"]);
    expect(effective.identity?.tone).toBe("detailed"); // local override
    expect(effective.identity?.name).toBe("Atlas"); // brain preserved
  });

  it("skips brain layer when no entry exists", async () => {
    const brain = new InMemorySemanticMemory();
    const { layers } = await resolvePersona({ agentId: "GHOST", brain });
    expect(layers).toEqual(["defaults"]);
  });

  it("skips local layer when file is missing", async () => {
    const { layers } = await resolvePersona({
      agentId: "X",
      localPath: "/no/such.yaml",
    });
    expect(layers).toEqual(["defaults"]);
  });
});
