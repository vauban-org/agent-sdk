/**
 * markdown-loader — prototype SKILL.md parser.
 *
 * Parses frontmatter (YAML-subset, no external dep) + markdown body.
 * Returns a typed SkillManifest validated against a Zod schema.
 *
 * Constraint: no new npm deps — uses only node:fs/promises + zod (already in pkg).
 *
 * @poc-jetable
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

// ── Zod schema for SKILL.md frontmatter ──────────────────────────────────────

const MetadataSchema = z
  .object({
    version: z.string().default("1.0.0"),
    category: z.string().optional(),
    tags: z.string().optional(),
    "model-hint": z.string().optional(),
    "env-required": z.string().optional(),
    "env-mode": z.enum(["all", "at-least-one"]).default("all"),
  })
  .strict();

export const SkillManifestSchema = z
  .object({
    /** kebab-case, 1-64 chars */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "name must be kebab-case"),
    /** 1-1024 chars */
    description: z.string().min(1).max(1024),
    /** Space-separated tool grant list, e.g. "Bash(curl:*) Read" */
    "allowed-tools": z.string().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ── Minimal YAML-subset parser (no external dep) ─────────────────────────────
// Supports: string scalars, nested objects (2-space indent), multi-line > strings.

function parseYamlSubset(raw: string): Record<string, unknown> {
  const lines = raw.split("\n");
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent > 0) {
      // nested key — handled by parent
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    // Multi-line folded scalar (>) — collect continuation lines
    if (rest === ">") {
      const parts: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        parts.push(lines[i].trim());
        i++;
      }
      result[key] = parts.filter(Boolean).join(" ");
      continue;
    }

    // Nested object — collect child lines with 2-space indent
    if (rest === "") {
      const childLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].startsWith("  ")) {
        childLines.push(lines[i].slice(2)); // strip 2-space indent
        i++;
      }
      if (childLines.length > 0) {
        result[key] = parseYamlSubset(childLines.join("\n"));
      }
      continue;
    }

    // Quoted string
    if (
      (rest.startsWith('"') && rest.endsWith('"')) ||
      (rest.startsWith("'") && rest.endsWith("'"))
    ) {
      result[key] = rest.slice(1, -1);
      i++;
      continue;
    }

    // Plain scalar
    result[key] = rest;
    i++;
  }

  return result;
}

// ── SKILL.md parser ───────────────────────────────────────────────────────────

export interface ParsedSkillFile {
  manifest: SkillManifest;
  body: string;
}

/**
 * Parse a SKILL.md file at `filePath`.
 * Extracts frontmatter (between --- delimiters) and validates with Zod.
 * Returns typed manifest + raw markdown body.
 */
export async function loadSkillMd(filePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(filePath, "utf-8");

  // Extract frontmatter block
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(
      `SKILL.md at ${filePath}: missing or malformed frontmatter (expected --- delimiters)`,
    );
  }

  const [, frontmatter, body] = fmMatch;
  const rawParsed = parseYamlSubset(frontmatter);

  // Validate with Zod
  const result = SkillManifestSchema.safeParse(rawParsed);
  if (!result.success) {
    throw new Error(
      `SKILL.md at ${filePath}: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return { manifest: result.data, body: body.trim() };
}
