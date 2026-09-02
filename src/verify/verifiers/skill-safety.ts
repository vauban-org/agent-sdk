/**
 * verify/verifiers/skill-safety.ts
 *
 * skillSafetyLens ; the write-time skill verifier (Beyond-Hermes Wave 2). A HARD
 * affirm "rule"-engine lens that gates a synthesized/edited skill BEFORE it is
 * persisted. It is the deterministic non-llm-judge anchor for the skill-capture
 * battery.
 *
 * HONEST SCOPE (recorded here and in the threat-coverage matrix): this catches
 * SYNTACTIC poisoning only ; references to tools that do not exist in the live
 * registry, leftover TODO/placeholder scaffolding, and degenerate (empty) bodies.
 * It does NOT catch a clean semantic injection (a skill whose natural-language
 * instructions pass every syntactic check yet still mis-direct the agent) ; that
 * is the runtime ActionGate's job. It does NOT catch a model-in-skill backdoor
 * (BadSkill, arXiv:2604.09378) ; that is closed by the markdown-only skill policy
 * (no embedded-model skills). Frontmatter validity is enforced upstream by the
 * Zod SkillManifestSchema in parseSkillMd ; the redundant name/description checks
 * here defend the case where a synthesized manifest reaches the lens unparsed.
 *
 * @module verify/verifiers/skill-safety
 */

import type { BatteryLens } from "../../compute/battery/types.js";
import type { ParsedSkillFile } from "../../skills/markdown/loader.js";
import { parseAllowedTools } from "../../skills/markdown/schema.js";

/**
 * Leftover scaffolding / unfinished-work markers. Matches the create-template
 * placeholders ("(describe ...", "(trigger ...") and the usual TODO family.
 * Deliberately does NOT match a bare "..." (too common in legitimate prose).
 */
const PLACEHOLDER_RE =
  /\bTODO\b|\bFIXME\b|\bXXX\b|\bPLACEHOLDER\b|\(describe\b|\(trigger\b|<insert\b/i;

/**
 * Minimum body size (rough tokens) below which a skill is treated as degenerate.
 * @public
 */
export const MIN_SKILL_BODY_TOKENS = 8;

/**
 * Evaluate the write-time skill-safety rules. Returns the list of violation
 * messages ; an empty list means the skill is syntactically clean. Pure and
 * deterministic.
 * @public
 */
export function skillSafetyDeny(
  parsed: ParsedSkillFile,
  knownTools: ReadonlySet<string>,
): string[] {
  const deny: string[] = [];

  // (1) every referenced tool must exist in the live registry.
  const refs = parseAllowedTools(parsed.manifest);
  const unknown = refs.filter((t) => !knownTools.has(t));
  if (unknown.length > 0) {
    deny.push(`skill references unknown tools: ${unknown.join(", ")}`);
  }

  // (2) no leftover TODO/placeholder/scaffold text in the body.
  if (PLACEHOLDER_RE.test(parsed.body)) {
    deny.push("skill body contains TODO/placeholder/scaffold text");
  }

  // (3) no degenerate (empty/near-empty) body.
  if (parsed.bodyTokens < MIN_SKILL_BODY_TOKENS) {
    deny.push(`skill body too thin (${parsed.bodyTokens} tokens, min ${MIN_SKILL_BODY_TOKENS})`);
  }

  // (4) defensive frontmatter checks (Zod enforces these upstream).
  if (!parsed.manifest.name?.trim()) {
    deny.push("skill manifest missing name");
  }
  if (!parsed.manifest.description?.trim()) {
    deny.push("skill manifest missing description");
  }

  return deny;
}

/**
 * True when the skill passes every write-time syntactic rule.
 * @public
 */
export function skillSafetyAllow(
  parsed: ParsedSkillFile,
  knownTools: ReadonlySet<string>,
): boolean {
  return skillSafetyDeny(parsed, knownTools).length === 0;
}

/**
 * Build the write-time skill-safety {@link BatteryLens}: a hard affirm rule lens
 * scoring 1 when the skill is syntactically clean and 0 (with the joined
 * violations as rationale) otherwise. Pair it with the skill-capture battery
 * (adrEco ADR-ECO-068).
 * @public
 */
export function skillSafetyLens(opts: {
  knownTools: ReadonlySet<string>;
  name?: string;
}): BatteryLens<ParsedSkillFile> {
  const known = opts.knownTools;
  return {
    verifier: {
      name: opts.name ?? "skill-safety",
      evaluate: (parsed: ParsedSkillFile) => {
        const denies = skillSafetyDeny(parsed, known);
        return denies.length === 0
          ? { score: 1, rationale: "skill-safety: clean (syntactic)" }
          : {
              score: 0,
              rationale: `skill-safety: deny ; ${denies.join("; ")}`,
            };
      },
    },
    polarity: "affirm",
    criticality: "hard",
    signature: { engine: "rule" },
  };
}
