/**
 * Tests for src/identity/persona-schema.ts
 *
 * Coverage:
 *   PersonaTone enum — all 3 valid values, invalid rejects
 *   PersonaFormality enum — all 3 valid values, invalid rejects
 *   PersonaExplainReasoning enum — all 3 valid values, invalid rejects
 *   PersonaAcknowledgmentStyle enum — all 3 valid values, invalid rejects
 *   PersonaSchema — empty object, all optional fields, invalid fields, strict mode
 *   IdentitySchema — name/role/language bounds, strict mode
 *   CommunicationSchema — max_response_length bounds
 *   DirectivesSchema — must/must_not arrays
 *   ForbiddenPatternSchema — required name+pattern fields
 *   WhitelistSchema — hashtags/mentions arrays
 *   ExamplesSchema — situation required, bad/good optional
 *   OutputContractsSchema — record keyed by string
 *   mergePersona — local wins over base, arrays override, records merge
 *   validatePersona — returns parsed result, throws on invalid
 *   DEFAULT_PERSONA — matches schema
 */

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DEFAULT_PERSONA,
  PersonaAcknowledgmentStyle,
  PersonaExplainReasoning,
  PersonaFormality,
  PersonaSchema,
  PersonaTone,
  mergePersona,
  validatePersona,
} from "../src/identity/persona-schema.js";

// ─── PersonaTone ─────────────────────────────────────────────────────────────

describe("PersonaTone", () => {
  it("accepts 'concise'", () => {
    expect(PersonaTone.parse("concise")).toBe("concise");
  });

  it("accepts 'detailed'", () => {
    expect(PersonaTone.parse("detailed")).toBe("detailed");
  });

  it("accepts 'pedagogical'", () => {
    expect(PersonaTone.parse("pedagogical")).toBe("pedagogical");
  });

  it("rejects an unknown tone", () => {
    expect(() => PersonaTone.parse("aggressive")).toThrow(ZodError);
  });

  it("rejects empty string", () => {
    expect(() => PersonaTone.parse("")).toThrow(ZodError);
  });
});

// ─── PersonaFormality ────────────────────────────────────────────────────────

describe("PersonaFormality", () => {
  it("accepts 'casual'", () => {
    expect(PersonaFormality.parse("casual")).toBe("casual");
  });

  it("accepts 'formal'", () => {
    expect(PersonaFormality.parse("formal")).toBe("formal");
  });

  it("accepts 'technical'", () => {
    expect(PersonaFormality.parse("technical")).toBe("technical");
  });

  it("rejects 'informal'", () => {
    expect(() => PersonaFormality.parse("informal")).toThrow(ZodError);
  });
});

// ─── PersonaExplainReasoning ─────────────────────────────────────────────────

describe("PersonaExplainReasoning", () => {
  it("accepts 'always'", () => {
    expect(PersonaExplainReasoning.parse("always")).toBe("always");
  });

  it("accepts 'on_error'", () => {
    expect(PersonaExplainReasoning.parse("on_error")).toBe("on_error");
  });

  it("accepts 'never'", () => {
    expect(PersonaExplainReasoning.parse("never")).toBe("never");
  });

  it("rejects 'sometimes'", () => {
    expect(() => PersonaExplainReasoning.parse("sometimes")).toThrow(ZodError);
  });
});

// ─── PersonaAcknowledgmentStyle ──────────────────────────────────────────────

describe("PersonaAcknowledgmentStyle", () => {
  it("accepts 'minimal'", () => {
    expect(PersonaAcknowledgmentStyle.parse("minimal")).toBe("minimal");
  });

  it("accepts 'detailed'", () => {
    expect(PersonaAcknowledgmentStyle.parse("detailed")).toBe("detailed");
  });

  it("accepts 'none'", () => {
    expect(PersonaAcknowledgmentStyle.parse("none")).toBe("none");
  });

  it("rejects 'verbose'", () => {
    expect(() => PersonaAcknowledgmentStyle.parse("verbose")).toThrow(ZodError);
  });
});

// ─── PersonaSchema — base ────────────────────────────────────────────────────

describe("PersonaSchema — base validation", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(() => PersonaSchema.parse({})).not.toThrow();
  });

  it("accepts object with identity only", () => {
    const result = PersonaSchema.parse({ identity: { name: "Vauban" } });
    expect(result.identity?.name).toBe("Vauban");
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    expect(() => PersonaSchema.parse({ unknownField: true })).toThrow(ZodError);
  });

  it("accepts full valid persona", () => {
    const persona = {
      identity: {
        name: "Sentinel",
        role: "Security auditor",
        tone: "concise",
        formality: "technical",
        language: "en",
      },
      traits: ["precise", "direct"],
      domain_expertise: ["Cairo", "ZK proofs", "Starknet"],
      communication: {
        max_response_length: 1000,
        use_analogies: false,
        explain_reasoning: "on_error",
        acknowledgment_style: "minimal",
      },
      directives: {
        must: ["cite sources", "flag assumptions"],
        must_not: ["use em-dashes", "add filler phrases"],
      },
      forbidden_patterns: [{ name: "em-dash", pattern: "—", scope: "output" }],
      whitelist: {
        hashtags: ["#ZK", "#Starknet"],
        mentions: ["@Starknet"],
      },
      examples: [
        {
          situation: "User asks for a summary",
          bad: "Here is a comprehensive and thorough breakdown...",
          good: "Summary: X happened because Y.",
        },
      ],
      output_contracts: {
        default: { description: "JSON object", schema_hint: "{}" },
      },
      extra_instructions: "Always output JSON.",
    };
    expect(() => PersonaSchema.parse(persona)).not.toThrow();
  });
});

// ─── PersonaSchema — identity sub-schema ─────────────────────────────────────

describe("PersonaSchema — identity validation", () => {
  it("rejects identity.language shorter than 2 chars", () => {
    expect(() => PersonaSchema.parse({ identity: { language: "e" } })).toThrow(ZodError);
  });

  it("rejects identity.language longer than 16 chars", () => {
    expect(() => PersonaSchema.parse({ identity: { language: "x".repeat(17) } })).toThrow(ZodError);
  });

  it("accepts identity.language at minimum length (2 chars)", () => {
    expect(() => PersonaSchema.parse({ identity: { language: "fr" } })).not.toThrow();
  });

  it("accepts identity.language BCP47 tag like 'fr-FR'", () => {
    expect(() => PersonaSchema.parse({ identity: { language: "fr-FR" } })).not.toThrow();
  });

  it("rejects identity.name empty string", () => {
    expect(() => PersonaSchema.parse({ identity: { name: "" } })).toThrow(ZodError);
  });

  it("rejects identity.name longer than 64 chars", () => {
    expect(() => PersonaSchema.parse({ identity: { name: "x".repeat(65) } })).toThrow(ZodError);
  });

  it("rejects identity with invalid tone value", () => {
    expect(() => PersonaSchema.parse({ identity: { tone: "aggressive" } })).toThrow(ZodError);
  });

  it("rejects unknown fields inside identity (strict mode)", () => {
    expect(() => PersonaSchema.parse({ identity: { unknownKey: "value" } })).toThrow(ZodError);
  });
});

// ─── PersonaSchema — communication sub-schema ────────────────────────────────

describe("PersonaSchema — communication validation", () => {
  it("rejects negative max_response_length", () => {
    expect(() => PersonaSchema.parse({ communication: { max_response_length: -1 } })).toThrow(
      ZodError,
    );
  });

  it("rejects max_response_length of zero", () => {
    expect(() => PersonaSchema.parse({ communication: { max_response_length: 0 } })).toThrow(
      ZodError,
    );
  });

  it("accepts valid max_response_length", () => {
    expect(() =>
      PersonaSchema.parse({ communication: { max_response_length: 500 } }),
    ).not.toThrow();
  });

  it("rejects max_response_length exceeding 100_000", () => {
    expect(() => PersonaSchema.parse({ communication: { max_response_length: 100_001 } })).toThrow(
      ZodError,
    );
  });

  it("rejects max_response_length that is not an integer", () => {
    expect(() => PersonaSchema.parse({ communication: { max_response_length: 1.5 } })).toThrow(
      ZodError,
    );
  });

  it("rejects unknown fields inside communication (strict mode)", () => {
    expect(() => PersonaSchema.parse({ communication: { verbosity: "high" } })).toThrow(ZodError);
  });
});

// ─── PersonaSchema — SDK 1.12 additive fields ────────────────────────────────

describe("PersonaSchema — directives", () => {
  it("accepts directives with must and must_not arrays", () => {
    expect(() =>
      PersonaSchema.parse({
        directives: { must: ["be concise"], must_not: ["use jargon"] },
      }),
    ).not.toThrow();
  });

  it("accepts directives with empty must array", () => {
    expect(() => PersonaSchema.parse({ directives: { must: [] } })).not.toThrow();
  });

  it("rejects directives with unknown field (strict mode)", () => {
    expect(() => PersonaSchema.parse({ directives: { should: ["be polite"] } })).toThrow(ZodError);
  });

  it("rejects directives.must entry longer than 512 chars", () => {
    expect(() => PersonaSchema.parse({ directives: { must: ["x".repeat(513)] } })).toThrow(
      ZodError,
    );
  });
});

describe("PersonaSchema — forbidden_patterns", () => {
  it("accepts a valid forbidden pattern", () => {
    expect(() =>
      PersonaSchema.parse({
        forbidden_patterns: [{ name: "em-dash", pattern: "—" }],
      }),
    ).not.toThrow();
  });

  it("accepts a forbidden pattern with optional scope", () => {
    expect(() =>
      PersonaSchema.parse({
        forbidden_patterns: [{ name: "em-dash", pattern: "—", scope: "output" }],
      }),
    ).not.toThrow();
  });

  it("rejects a forbidden pattern missing required 'pattern' field", () => {
    expect(() =>
      PersonaSchema.parse({
        forbidden_patterns: [{ name: "em-dash" }],
      }),
    ).toThrow(ZodError);
  });

  it("rejects a forbidden pattern missing required 'name' field", () => {
    expect(() =>
      PersonaSchema.parse({
        forbidden_patterns: [{ pattern: "—" }],
      }),
    ).toThrow(ZodError);
  });
});

describe("PersonaSchema — whitelist", () => {
  it("accepts whitelist with hashtags and mentions", () => {
    expect(() =>
      PersonaSchema.parse({
        whitelist: { hashtags: ["#ZK"], mentions: ["@Starknet"] },
      }),
    ).not.toThrow();
  });

  it("rejects hashtag longer than 32 chars", () => {
    expect(() =>
      PersonaSchema.parse({
        whitelist: { hashtags: [`#${"x".repeat(32)}`] },
      }),
    ).toThrow(ZodError);
  });
});

describe("PersonaSchema — examples", () => {
  it("accepts an example with situation only", () => {
    expect(() =>
      PersonaSchema.parse({
        examples: [{ situation: "User asks for a summary" }],
      }),
    ).not.toThrow();
  });

  it("accepts an example with situation, bad, and good", () => {
    expect(() =>
      PersonaSchema.parse({
        examples: [{ situation: "S", bad: "bad answer", good: "good answer" }],
      }),
    ).not.toThrow();
  });

  it("rejects an example with empty situation string", () => {
    expect(() => PersonaSchema.parse({ examples: [{ situation: "" }] })).toThrow(ZodError);
  });
});

describe("PersonaSchema — output_contracts", () => {
  it("accepts output_contracts with valid entries", () => {
    expect(() =>
      PersonaSchema.parse({
        output_contracts: {
          default: { description: "JSON", schema_hint: "{}" },
        },
      }),
    ).not.toThrow();
  });

  it("accepts output_contracts with empty object", () => {
    expect(() => PersonaSchema.parse({ output_contracts: {} })).not.toThrow();
  });
});

describe("PersonaSchema — extra_instructions", () => {
  it("accepts a valid extra_instructions string", () => {
    expect(() => PersonaSchema.parse({ extra_instructions: "Always output JSON." })).not.toThrow();
  });

  it("rejects empty extra_instructions string", () => {
    expect(() => PersonaSchema.parse({ extra_instructions: "" })).toThrow(ZodError);
  });

  it("rejects extra_instructions exceeding 16_384 chars", () => {
    expect(() => PersonaSchema.parse({ extra_instructions: "x".repeat(16_385) })).toThrow(ZodError);
  });
});

// ─── DEFAULT_PERSONA ──────────────────────────────────────────────────────────

describe("DEFAULT_PERSONA", () => {
  it("is a valid persona according to the schema", () => {
    expect(() => PersonaSchema.parse(DEFAULT_PERSONA)).not.toThrow();
  });

  it("has identity.tone 'concise'", () => {
    expect(DEFAULT_PERSONA.identity?.tone).toBe("concise");
  });

  it("has identity.formality 'technical'", () => {
    expect(DEFAULT_PERSONA.identity?.formality).toBe("technical");
  });

  it("has communication.explain_reasoning 'on_error'", () => {
    expect(DEFAULT_PERSONA.communication?.explain_reasoning).toBe("on_error");
  });
});

// ─── mergePersona ─────────────────────────────────────────────────────────────

describe("mergePersona", () => {
  it("local identity fields win over base", () => {
    const base = { identity: { name: "Base" } };
    const local = { identity: { name: "Local" } };
    const result = mergePersona(base, local);
    expect(result.identity?.name).toBe("Local");
  });

  it("base identity fields are preserved when local does not override", () => {
    const base = { identity: { name: "Base", role: "auditor" } };
    const local = { identity: { name: "Local" } };
    const result = mergePersona(base, local);
    expect(result.identity?.role).toBe("auditor");
  });

  it("local traits array replaces base traits array", () => {
    const base = { traits: ["fast"] };
    const local = { traits: ["precise"] };
    const result = mergePersona(base, local);
    expect(result.traits).toEqual(["precise"]);
  });

  it("base traits preserved when local has no traits", () => {
    const base = { traits: ["fast"] };
    const local = {};
    const result = mergePersona(base, local);
    expect(result.traits).toEqual(["fast"]);
  });

  it("output_contracts are shallow-merged (local overrides same key)", () => {
    const base = {
      output_contracts: {
        k1: { description: "base" },
        k2: { description: "shared-base" },
      },
    };
    const local = {
      output_contracts: {
        k2: { description: "shared-local" },
        k3: { description: "new" },
      },
    };
    const result = mergePersona(base, local);
    expect(result.output_contracts?.k1?.description).toBe("base");
    expect(result.output_contracts?.k2?.description).toBe("shared-local");
    expect(result.output_contracts?.k3?.description).toBe("new");
  });

  it("local extra_instructions wins over base", () => {
    const base = { extra_instructions: "base instructions" };
    const local = { extra_instructions: "local instructions" };
    const result = mergePersona(base, local);
    expect(result.extra_instructions).toBe("local instructions");
  });

  it("base extra_instructions preserved when local omits it", () => {
    const base = { extra_instructions: "base instructions" };
    const local = {};
    const result = mergePersona(base, local);
    expect(result.extra_instructions).toBe("base instructions");
  });

  it("local forbidden_patterns replace base forbidden_patterns", () => {
    const base = { forbidden_patterns: [{ name: "dash", pattern: "—" }] };
    const local = {
      forbidden_patterns: [{ name: "ellipsis", pattern: "..." }],
    };
    const result = mergePersona(base, local);
    expect(result.forbidden_patterns).toEqual([{ name: "ellipsis", pattern: "..." }]);
  });
});

// ─── validatePersona ─────────────────────────────────────────────────────────

describe("validatePersona", () => {
  it("returns parsed persona for valid input", () => {
    const result = validatePersona({ identity: { tone: "concise" } });
    expect(result.identity?.tone).toBe("concise");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => validatePersona({ identity: { tone: "invalid-tone" } })).toThrow(ZodError);
  });

  it("throws for unknown top-level field", () => {
    expect(() => validatePersona({ notAField: true })).toThrow(ZodError);
  });
});
