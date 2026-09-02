/**
 * AgentPersona schema — Sprint CC v3.1 (Livrable E).
 *
 * Persona is a structured description of how an agent should communicate:
 * tone, formality, language, domain expertise, response shape preferences.
 * Stored in Brain Tier 3 (semantic) per agent + override locally via
 * `.cc/persona.yaml`.
 *
 * The schema is intentionally minimal — additive evolution preferred over
 * breaking changes. All fields are optional; the resolved persona is the
 * merge of (1) Brain-stored persona, (2) local overrides, (3) defaults.
 *
 * Spec reference:
 *   - Plan canonical v3.1 §Livrable E
 *   - ADR-ECO-034 §"AgentPersona via Brain Tier 3 semantic"
 *   - SDK 1.12 additive extension (directives, forbidden_patterns, whitelist,
 *     examples, output_contracts, extra_instructions) — marketing-grade personas.
 *
 * @public
 */

import { z } from "zod";

/** @public */
export const PersonaTone = z.enum(["concise", "detailed", "pedagogical"]);
/** @public */
export type PersonaTone = z.infer<typeof PersonaTone>;

/** @public */
export const PersonaFormality = z.enum(["casual", "formal", "technical"]);
/** @public */
export type PersonaFormality = z.infer<typeof PersonaFormality>;

/** @public */
export const PersonaExplainReasoning = z.enum(["always", "on_error", "never"]);
/** @public */
export type PersonaExplainReasoning = z.infer<typeof PersonaExplainReasoning>;

/** @public */
export const PersonaAcknowledgmentStyle = z.enum(["minimal", "detailed", "none"]);
/** @public */
export type PersonaAcknowledgmentStyle = z.infer<typeof PersonaAcknowledgmentStyle>;

// ─── Schemas ────────────────────────────────────────────────────────────────

const IdentitySchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    role: z.string().min(1).max(256).optional(),
    tone: PersonaTone.optional(),
    formality: PersonaFormality.optional(),
    /** BCP 47 language tag (e.g. "en", "fr-FR"). Free-form on purpose. */
    language: z.string().min(2).max(16).optional(),
  })
  .strict();

const CommunicationSchema = z
  .object({
    max_response_length: z.number().int().positive().max(100_000).optional(),
    use_analogies: z.boolean().optional(),
    explain_reasoning: PersonaExplainReasoning.optional(),
    acknowledgment_style: PersonaAcknowledgmentStyle.optional(),
  })
  .strict();

// ─── SDK 1.12 additive blocks ──────────────────────────────────────────────

const DirectivesSchema = z
  .object({
    must: z.array(z.string().min(1).max(512)).max(32).optional(),
    must_not: z.array(z.string().min(1).max(512)).max(32).optional(),
  })
  .strict();

const ForbiddenPatternSchema = z
  .object({
    name: z.string().min(1).max(64),
    pattern: z.string().min(1).max(512),
    scope: z.string().min(1).max(64).optional(),
  })
  .strict();

const WhitelistSchema = z
  .object({
    hashtags: z.array(z.string().min(1).max(32)).max(32).optional(),
    mentions: z.array(z.string().min(1).max(64)).max(64).optional(),
  })
  .strict();

const ExampleSchema = z
  .object({
    situation: z.string().min(1).max(512),
    bad: z.string().min(1).max(2048).optional(),
    good: z.string().min(1).max(2048).optional(),
  })
  .strict();

const OutputContractSchema = z
  .object({
    description: z.string().min(1).max(512).optional(),
    schema_hint: z.string().min(1).max(4096).optional(),
  })
  .strict();

/** @public */
export const PersonaSchema = z
  .object({
    identity: IdentitySchema.optional(),
    traits: z.array(z.string().min(1).max(64)).max(16).optional(),
    domain_expertise: z.array(z.string().min(1).max(128)).max(32).optional(),
    communication: CommunicationSchema.optional(),
    // SDK 1.12 additive fields ───────────────────────────────────────────
    directives: DirectivesSchema.optional(),
    forbidden_patterns: z.array(ForbiddenPatternSchema).max(64).optional(),
    whitelist: WhitelistSchema.optional(),
    examples: z.array(ExampleSchema).max(32).optional(),
    output_contracts: z.record(z.string().min(1).max(64), OutputContractSchema).optional(),
    extra_instructions: z.string().min(1).max(16_384).optional(),
  })
  .strict();

/** @public */
export type AgentPersona = z.infer<typeof PersonaSchema>;

// ─── Defaults ──────────────────────────────────────────────────────────────

/** @public */
export const DEFAULT_PERSONA: AgentPersona = {
  identity: {
    tone: "concise",
    formality: "technical",
    language: "en",
  },
  traits: [],
  domain_expertise: [],
  communication: {
    explain_reasoning: "on_error",
    acknowledgment_style: "minimal",
  },
};

// ─── Merge ────────────────────────────────────────────────────────────────

/**
 * Deep-merge two personas. `local` wins over `base` field-by-field.
 *
 * Arrays (traits, domain_expertise, forbidden_patterns, examples) follow
 * override semantics: a `local` array REPLACES the `base` array entirely.
 * Records (output_contracts) are shallow-merged: `local` entries override
 * `base` entries with the same key. To extend rather than override, the
 * caller must concatenate / spread before calling `mergePersona`.
 *
 * The merge is total (no Zod validation here — callers should validate
 * inputs and the result separately). This makes mergePersona suitable for
 * progressive composition where intermediate values may not yet satisfy
 * the schema.
 * @public
 */
export function mergePersona(base: AgentPersona, local: AgentPersona): AgentPersona {
  const merged: AgentPersona = {
    identity: {
      ...base.identity,
      ...local.identity,
    },
    traits: local.traits ?? base.traits,
    domain_expertise: local.domain_expertise ?? base.domain_expertise,
    communication: {
      ...base.communication,
      ...local.communication,
    },
  };

  // SDK 1.12 additive fields — only emit on output if at least one side defines them
  const directivesBase = base.directives;
  const directivesLocal = local.directives;
  if (directivesBase || directivesLocal) {
    merged.directives = {
      must: directivesLocal?.must ?? directivesBase?.must,
      must_not: directivesLocal?.must_not ?? directivesBase?.must_not,
    };
  }

  if (local.forbidden_patterns !== undefined || base.forbidden_patterns !== undefined) {
    merged.forbidden_patterns = local.forbidden_patterns ?? base.forbidden_patterns;
  }

  const whitelistBase = base.whitelist;
  const whitelistLocal = local.whitelist;
  if (whitelistBase || whitelistLocal) {
    merged.whitelist = {
      hashtags: whitelistLocal?.hashtags ?? whitelistBase?.hashtags,
      mentions: whitelistLocal?.mentions ?? whitelistBase?.mentions,
    };
  }

  if (local.examples !== undefined || base.examples !== undefined) {
    merged.examples = local.examples ?? base.examples;
  }

  if (local.output_contracts !== undefined || base.output_contracts !== undefined) {
    merged.output_contracts = {
      ...base.output_contracts,
      ...local.output_contracts,
    };
  }

  if (local.extra_instructions !== undefined || base.extra_instructions !== undefined) {
    merged.extra_instructions = local.extra_instructions ?? base.extra_instructions;
  }

  return merged;
}

/**
 * Validate a persona object against the schema. Returns the parsed result
 * (with Zod typing) or throws a typed error.
 * @public
 */
export function validatePersona(input: unknown): AgentPersona {
  return PersonaSchema.parse(input);
}
