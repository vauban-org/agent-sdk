/**
 * buildPersonaPromptBlock — converts an AgentPersona into a system-prompt block.
 *
 * The output is a compact, model-neutral instruction block that can be prepended
 * to any system prompt. It is intentionally terse — LLMs handle short, directive
 * blocks better than verbose persona descriptions.
 *
 * Format contract:
 *   - Starts with a blank line so callers can safely concatenate to an existing
 *     system prompt with `${base}\n${buildPersonaPromptBlock(persona)}`.
 *   - Empty fields are omitted — the function never emits empty bullet points.
 *   - The block is bounded by `--- persona ---` / `--- end persona ---` markers
 *     for easy parsing / stripping in tests and audits.
 *
 * SDK 1.12 additive sections (rendered after the core block, before end marker):
 *   - directives (MUST / MUST NOT bullets)
 *   - whitelist (allowed hashtags + @-mentions)
 *   - forbidden_patterns (DO NOT emit content matching X)
 *   - output_contracts (per action_type expected output shape)
 *   - examples (BAD vs GOOD teaching pairs)
 *   - extra_instructions (raw markdown overflow appended last)
 *
 * @public
 */

import type { AgentPersona } from "./persona-schema.js";

/**
 * Build a system-prompt instruction block from a resolved `AgentPersona`.
 *
 * Returns an empty string if the persona has no actionable fields, so
 * callers can unconditionally concatenate without emitting noise.
 * @public
 */
export function buildPersonaPromptBlock(persona: AgentPersona): string {
  const lines: string[] = [];

  const {
    identity,
    traits,
    domain_expertise,
    communication,
    directives,
    forbidden_patterns,
    whitelist,
    examples,
    output_contracts,
    extra_instructions,
  } = persona;

  if (identity?.name) {
    lines.push(`You are ${identity.name}.`);
  }
  if (identity?.role) {
    lines.push(`Role: ${identity.role}.`);
  }

  const styleLines: string[] = [];
  if (identity?.tone) styleLines.push(identity.tone);
  if (identity?.formality) styleLines.push(identity.formality);
  if (styleLines.length) {
    lines.push(`Communication style: ${styleLines.join(", ")}.`);
  }

  if (identity?.language && identity.language !== "en") {
    lines.push(`Respond in ${identity.language}.`);
  }

  if (traits && traits.length > 0) {
    lines.push(`Traits: ${traits.join(", ")}.`);
  }

  if (domain_expertise && domain_expertise.length > 0) {
    lines.push(`Domain expertise: ${domain_expertise.join(", ")}.`);
  }

  if (communication?.max_response_length) {
    lines.push(`Keep responses under ${communication.max_response_length} characters.`);
  }

  if (communication?.explain_reasoning === "always") {
    lines.push("Always explain your reasoning step by step.");
  } else if (communication?.explain_reasoning === "never") {
    lines.push("Do not explain your reasoning. Emit results only.");
  }

  if (communication?.acknowledgment_style === "none") {
    lines.push('Do not acknowledge the task. Skip preamble like "Sure," or "I will".');
  } else if (communication?.acknowledgment_style === "minimal") {
    lines.push("Skip task acknowledgment preamble. Go directly to output.");
  }

  if (communication?.use_analogies === false) {
    lines.push("Do not use analogies.");
  }

  // ─── SDK 1.12 additive sections ─────────────────────────────────────────

  const must = directives?.must?.filter((s) => s.trim().length > 0) ?? [];
  if (must.length > 0) {
    lines.push("Mandatory rules (MUST):");
    for (const rule of must) lines.push(`  - ${rule}`);
  }

  const mustNot = directives?.must_not?.filter((s) => s.trim().length > 0) ?? [];
  if (mustNot.length > 0) {
    lines.push("Forbidden behaviors (MUST NOT):");
    for (const rule of mustNot) lines.push(`  - ${rule}`);
  }

  const wlHashtags = whitelist?.hashtags?.filter((h) => h.trim().length > 0) ?? [];
  const wlMentions = whitelist?.mentions?.filter((m) => m.trim().length > 0) ?? [];
  if (wlHashtags.length > 0 || wlMentions.length > 0) {
    lines.push("Whitelist (only emit items from these lists):");
    if (wlHashtags.length > 0) {
      lines.push(`  - Hashtags: ${wlHashtags.join(", ")}`);
    }
    if (wlMentions.length > 0) {
      lines.push(`  - Mentions: ${wlMentions.join(", ")}`);
    }
  }

  if (forbidden_patterns && forbidden_patterns.length > 0) {
    lines.push("Forbidden patterns (DO NOT emit content matching any of):");
    for (const fp of forbidden_patterns) {
      const scope = fp.scope ? ` [scope: ${fp.scope}]` : "";
      lines.push(`  - ${fp.name}${scope}: ${fp.pattern}`);
    }
  }

  if (output_contracts) {
    const entries = Object.entries(output_contracts);
    if (entries.length > 0) {
      lines.push("Output contracts by action_type:");
      for (const [actionType, contract] of entries) {
        const descPart = contract.description ? ` — ${contract.description}` : "";
        lines.push(`  - ${actionType}${descPart}`);
        if (contract.schema_hint) {
          lines.push(`    Expected shape: ${contract.schema_hint}`);
        }
      }
    }
  }

  if (examples && examples.length > 0) {
    lines.push("Examples (BAD vs GOOD):");
    for (const ex of examples) {
      lines.push(`  - Situation: ${ex.situation}`);
      if (ex.bad) lines.push(`    BAD: ${ex.bad}`);
      if (ex.good) lines.push(`    GOOD: ${ex.good}`);
    }
  }

  if (extra_instructions && extra_instructions.trim().length > 0) {
    lines.push("Additional instructions:");
    lines.push(extra_instructions.trim());
  }

  if (lines.length === 0) return "";

  return `\n--- persona ---\n${lines.join("\n")}\n--- end persona ---`;
}
