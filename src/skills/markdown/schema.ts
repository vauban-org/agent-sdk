/**
 * SKILL.md frontmatter schema — agentskills.io standard + Vauban extensions.
 *
 * Standard fields (agentskills.io spec):
 *   - `name`         1-64 chars, kebab-case
 *   - `description`  1-1024 chars
 *   - `license`      free-text (optional)
 *   - `compatibility` free-text (optional, e.g. "Requires STARKNET_RPC_URL")
 *   - `allowed-tools` space-separated string, e.g. "Bash(curl:*) Bash(jq:*) Read"
 *   - `metadata`     arbitrary k/v map (per spec — extension surface)
 *
 * Vauban extensions live UNDER `metadata` (spec-compliant — ignored gracefully
 * by other agentskills.io-conforming tools). Namespaced as `vauban.*` keys
 * for clarity:
 *   - `metadata.vauban.tier`           "official" | "verified" | "unverified"
 *   - `metadata.vauban.subagent`       agent id this skill belongs to
 *   - `metadata.vauban.model-hint`     suggested LLM (forwarded to EconomyRouter)
 *   - `metadata.vauban.proof.poseidon_hash`  hex
 *   - `metadata.vauban.proof.tsa_token`      base64 RFC3161
 *   - `metadata.vauban.proof.starknet_tx`    hex
 *   - `metadata.vauban.biscuit.required_caps` array of capability strings
 *   - `metadata.vauban.biscuit.max_scope`     "project" | "session" | "global"
 *   - `metadata.vauban.audit_status`   "approved" | "review" | "rejected"
 *
 * Spec reference: https://agentskills.io/specification
 * @see ADR-ECO-034 — skills TS↔MD coexistence
 * @public
 */

import { z } from "zod";

// ── Vauban metadata extension schemas ────────────────────────────────────────

/** @public */
export const VaubanSkillTier = z.enum(["official", "verified", "unverified"]);
/** @public */
export type VaubanSkillTier = z.infer<typeof VaubanSkillTier>;

/** @public */
export const VaubanBiscuitScope = z.enum(["project", "session", "global"]);
/** @public */
export type VaubanBiscuitScope = z.infer<typeof VaubanBiscuitScope>;

/** @public */
export const VaubanAuditStatus = z.enum(["approved", "review", "rejected"]);
/** @public */
export type VaubanAuditStatus = z.infer<typeof VaubanAuditStatus>;

const VaubanProofExtensionSchema = z
  .object({
    poseidon_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
    tsa_token: z.string().optional(),
    starknet_tx: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/)
      .optional(),
    anchored_at: z.string().datetime().optional(),
  })
  .strict()
  .partial();

const VaubanBiscuitExtensionSchema = z
  .object({
    required_caps: z.array(z.string()).optional(),
    max_scope: VaubanBiscuitScope.optional(),
  })
  .strict()
  .partial();

const VaubanExtensionSchema = z
  .object({
    tier: VaubanSkillTier.optional(),
    subagent: z.string().optional(),
    "model-hint": z.string().optional(),
    proof: VaubanProofExtensionSchema.optional(),
    biscuit: VaubanBiscuitExtensionSchema.optional(),
    audit_status: VaubanAuditStatus.optional(),
    observability_metric: z.string().optional(),
  })
  .strict()
  .partial();

// ── Generic metadata (per agentskills.io: arbitrary k/v) ─────────────────────

const StandardMetadataKnownKeys = z
  .object({
    version: z.string().optional(),
    category: z.string().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    author: z.string().optional(),
    "env-required": z.string().optional(),
    "env-mode": z.enum(["all", "at-least-one"]).optional(),
    vauban: VaubanExtensionSchema.optional(),
  })
  .partial();

const MetadataSchema = StandardMetadataKnownKeys.passthrough();

// ── Top-level SKILL.md frontmatter schema ────────────────────────────────────

const KEBAB_CASE = /^[a-z0-9][a-z0-9-]*$/;

/** @public */
export const SkillManifestSchema = z
  .object({
    name: z
      .string()
      .min(1, "name must be 1-64 chars")
      .max(64, "name must be 1-64 chars")
      .regex(KEBAB_CASE, "name must be kebab-case (lowercase, digits, hyphens)"),
    description: z
      .string()
      .min(1, "description must be 1-1024 chars")
      .max(1024, "description must be 1-1024 chars"),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    "allowed-tools": z.string().optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

/** @public */
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the Vauban tier from a manifest, defaulting to `unverified` per
 * the trust-stratification rule: any skill without an explicit tier MUST be
 * sandboxed as community-untrusted.
 * @public
 */
export function resolveTier(manifest: SkillManifest): VaubanSkillTier {
  return manifest.metadata?.vauban?.tier ?? "unverified";
}

/**
 * Parse the space-separated `allowed-tools` string into an array. Empty string
 * returns []. Whitespace runs collapse. Examples:
 *   "Bash(curl:*) Read"      → ["Bash(curl:*)", "Read"]
 *   "Bash(curl:*)  Bash(jq)" → ["Bash(curl:*)", "Bash(jq)"]
 * @public
 */
export function parseAllowedTools(manifest: SkillManifest): string[] {
  const raw = manifest["allowed-tools"];
  if (!raw) return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}
