/**
 * AgentPersona — load, save, and resolve a per-agent persona.
 *
 * Pipeline:
 *   1. Resolve persona for agent X
 *   2. base = DEFAULT_PERSONA
 *   3. brain = loadFromBrain(X) (Tier 3 semantic memory query)
 *   4. local = loadFromFile(`.cc/persona.yaml`) — optional
 *   5. effective = merge(base, brain, local)
 *
 * Brain entries use category `agent-persona`, tags `["persona", agentId]`.
 * The latest entry per agent wins (Brain query returns entries sorted by
 * recency).
 *
 * @see ./persona-schema.ts
 * @public
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SemanticMemoryPort } from "../ports/brain.js";
import {
  type AgentPersona,
  DEFAULT_PERSONA,
  PersonaSchema,
  mergePersona,
  validatePersona,
} from "./persona-schema.js";

/** @public */
export const PERSONA_BRAIN_CATEGORY = "agent-persona";

/**
 * Tags used to query/archive a persona for a given agent.
 * @public
 */
export function personaTags(agentId: string): string[] {
  return ["persona", agentId];
}

// ─── Brain layer ────────────────────────────────────────────────────────────

/**
 * Save (archive) a persona for an agent in Brain Tier 3 (semantic).
 *
 * The persona is serialized as JSON in the `content` field — keep this
 * structured so future queries can parse it deterministically. Tags include
 * the agent id so per-agent retrieval is precise.
 *
 * Returns the archived entry id, or null when the brain port returns null
 * (e.g. replay mode, no brain configured).
 * @public
 */
export async function savePersonaToBrain(
  brain: SemanticMemoryPort,
  agentId: string,
  persona: AgentPersona,
): Promise<string | null> {
  validatePersona(persona);
  // Wrap the JSON body with a discoverable header line — FTS-backed Brain
  // backends use the query string as a keyword filter, so the content MUST
  // contain the literal "persona" + agent id for `query("persona ...")` hits.
  const content = `persona for agent ${agentId}\n${JSON.stringify(persona)}`;
  const entry = await brain.archive({
    content,
    content_type: "persona",
    category: PERSONA_BRAIN_CATEGORY,
    tags: personaTags(agentId),
    metadata: { agent_id: agentId, schema_version: 1 },
  });
  return entry?.id ?? null;
}

/**
 * Extract the JSON body from a persona Brain entry (strips the header line).
 * Returns null if the content doesn't follow the wrapper format.
 */
function extractPersonaJson(content: string): string | null {
  const nl = content.indexOf("\n");
  if (nl === -1) {
    // Backward-compat: legacy entries stored raw JSON.
    return content;
  }
  return content.slice(nl + 1);
}

/**
 * Query Brain for the latest persona for an agent.
 *
 * Returns the parsed persona or `null` if no entry is found (or if the
 * latest entry's content does not parse).
 * @public
 */
export async function loadPersonaFromBrain(
  brain: SemanticMemoryPort,
  agentId: string,
): Promise<AgentPersona | null> {
  const results = await brain.query("persona", {
    category: PERSONA_BRAIN_CATEGORY,
    tags: personaTags(agentId),
    limit: 5,
  });
  if (results.length === 0) return null;
  // Prefer the most recent entry by created_at if available.
  const sorted = [...results].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  });
  for (const entry of sorted) {
    const json = extractPersonaJson(entry.content);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      const validated = PersonaSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // skip malformed entry, try next
    }
  }
  return null;
}

// ─── File layer ─────────────────────────────────────────────────────────────

/**
 * Load a persona from a YAML file. Returns null if the file is missing or
 * the content does not validate. Throws only on filesystem errors other
 * than ENOENT.
 * @public
 */
export async function loadPersonaFromFile(path: string): Promise<AgentPersona | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }
  const result = PersonaSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Persist a persona to a YAML file (overwrites). Validates first.
 * @public
 */
export async function savePersonaToFile(path: string, persona: AgentPersona): Promise<void> {
  const validated = validatePersona(persona);
  const yaml = stringifyYaml(validated, { indent: 2 });
  await writeFile(path, yaml, "utf-8");
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/** @public */
export interface ResolvePersonaOptions {
  agentId: string;
  brain?: SemanticMemoryPort;
  localPath?: string;
}

/** @public */
export interface ResolvedPersona {
  effective: AgentPersona;
  /** Layers actually applied, in order (latest wins). */
  layers: Array<"defaults" | "brain" | "local">;
}

/**
 * Resolve the effective persona for an agent.
 *
 * Composition order (each layer overrides the previous):
 *   1. DEFAULT_PERSONA
 *   2. Brain entry (Tier 3 semantic, optional)
 *   3. Local `.cc/persona.yaml` (optional)
 *
 * The returned `layers` array documents which sources contributed, useful
 * for diagnostics (e.g. `cc persona show --explain`).
 * @public
 */
export async function resolvePersona(opts: ResolvePersonaOptions): Promise<ResolvedPersona> {
  const layers: ResolvedPersona["layers"] = ["defaults"];
  let effective: AgentPersona = DEFAULT_PERSONA;
  if (opts.brain) {
    const fromBrain = await loadPersonaFromBrain(opts.brain, opts.agentId);
    if (fromBrain) {
      effective = mergePersona(effective, fromBrain);
      layers.push("brain");
    }
  }
  if (opts.localPath) {
    const fromFile = await loadPersonaFromFile(opts.localPath);
    if (fromFile) {
      effective = mergePersona(effective, fromFile);
      layers.push("local");
    }
  }
  return { effective, layers };
}
