/**
 * SKILL.md loader — agentskills.io standard parser.
 *
 * Reads a SKILL.md file, splits frontmatter from body, parses YAML via the
 * `yaml` package (battle-tested), validates against `SkillManifestSchema`,
 * and returns a typed `ParsedSkillFile`.
 *
 * Constraints:
 *   - No new npm deps (uses `yaml` already in package.json).
 *   - Frontmatter delimiters: `---\n` ... `\n---\n`.
 *   - Body returned verbatim (markdown — no rendering).
 *   - Validation errors are typed (SkillMdParseError / SkillMdValidationError).
 *
 * Progressive disclosure tiers (per agentskills.io spec):
 *   - Discovery   (~100 tok) — name + description only
 *   - Pre-activate (~500 tok) — full frontmatter + body excerpt
 *   - Activate    — full body (≤8000 tok recommended)
 *
 * Spec reference: https://agentskills.io/specification
 * @see ADR-ECO-034 — skills TS↔MD coexistence
 * @public
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { SkillMdParseError, SkillMdValidationError } from "../errors.js";
import {
  type SkillManifest,
  SkillManifestSchema,
  type VaubanSkillTier,
  resolveTier,
} from "./schema.js";

// `---` at line start, then arbitrary content, then `---` at line start. Body follows.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** @public */
export interface ParsedSkillFile {
  manifest: SkillManifest;
  body: string;
  tier: VaubanSkillTier;
  /** Tokens (rough heuristic ~4 chars/token) for progressive disclosure. */
  bodyTokens: number;
}

/**
 * Load and parse a SKILL.md file from disk.
 *
 * @throws SkillMdParseError    when frontmatter delimiters are missing or YAML is invalid
 * @throws SkillMdValidationError when frontmatter fails Zod schema validation
 * @public
 */
export async function loadSkillMd(filePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(filePath, "utf-8");
  return parseSkillMd(raw, filePath);
}

/**
 * Parse SKILL.md content from a string (in-memory). Useful for tests and
 * embedded skills.
 * @public
 */
export function parseSkillMd(raw: string, source = "<inline>"): ParsedSkillFile {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    throw new SkillMdParseError(
      source,
      "missing or malformed frontmatter (expected '---' delimiters on first line)",
    );
  }
  const [, frontmatterText, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillMdParseError(source, `YAML parse error — ${message}`);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillMdParseError(
      source,
      `frontmatter must be a YAML object (got ${
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed
      })`,
    );
  }

  const result = SkillManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new SkillMdValidationError(
      source,
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }

  const manifest = result.data;
  const trimmedBody = body.trim();
  return {
    manifest,
    body: trimmedBody,
    tier: resolveTier(manifest),
    bodyTokens: Math.ceil(trimmedBody.length / 4),
  };
}

/**
 * Produce the "discovery" projection (~100 tokens): name + description only.
 * Used by the catalogue / progressive disclosure layer to keep startup cost low.
 * @public
 */
export function toDiscoveryEntry(parsed: ParsedSkillFile): {
  name: string;
  description: string;
  tier: VaubanSkillTier;
} {
  return {
    name: parsed.manifest.name,
    description: parsed.manifest.description,
    tier: parsed.tier,
  };
}
