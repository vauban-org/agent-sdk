/**
 * SkillRegistryBuilder — generic skill assembly for OODA agent consumers.
 *
 * Promoted from `forge/src/agents/shared/skill-registry-builder.ts` (sprint-616:quick-3).
 * Replaces 9 quasi-identical `buildXxxSkills()` functions in Forge with a single
 * `buildSkills({ agentId, domain, extras })` factory.
 *
 * Pattern: base skills (universal) + domain extras (least privilege per agent).
 *
 * @public @since 0.18.0
 */

import { z } from "zod";
import type { Skill, SkillRegistry } from "../orchestration/ooda/skills.js";
import type { BrainPort } from "../ports/brain.js";
import type { LoggerPort } from "../ports/logger.js";
import { BASE_SKILL_NAMES } from "./base-skills.js";
import type { DomainSkillEntry } from "./base-skills.js";
import { brainQuery } from "./brain-query.js";
import { brainStore } from "./brain-store.js";
import { httpFetch } from "./http-fetch.js";
import { slackNotify } from "./slack-notify.js";

// ─── Public Types ──────────────────────────────────────────────────────────────

/**
 * Dependencies injected at skill construction time.
 * Matches Forge's `SkillBuilderDeps` / `SkillDeps` — unified here.
 * @public
 */
export interface SkillBuilderDeps {
  /** Brain memory port for brain-query / brain-store skills. */
  readonly brain?: BrainPort;
  /** Logger for debug / audit trails inside skills. */
  readonly logger: LoggerPort;
  /** Slack webhook URL for slack-notify. Optional. */
  readonly slackWebhookUrl?: string;
  /** LiteLLM base URL for llm-complete. Optional. */
  readonly litellmUrl?: string;
  /** LiteLLM API key for llm-complete. Optional. */
  readonly litellmApiKey?: string;
}

/**
 * Options for `buildSkills`.
 * @public
 */
export interface BuildSkillsOptions {
  /** Agent identifier (used for debug traces and schema validation). */
  readonly agentId: string;
  /** Resolved dependencies at construction time. */
  readonly deps: SkillBuilderDeps;
  /**
   * Domain name (e.g. "revenue", "ops", "product").
   * Used for documentation + future audit trail.
   */
  readonly domain: string;
  /**
   * Extra skills to merge on top of the base registry.
   * These must be domain-specific (e.g. prometheus-query, telegram-notify).
   * Duplicates against base skills are rejected at validation time.
   */
  readonly extras?: DomainSkillEntry[];
}

/**
 * Assembled skill registry, split for audit + introspection.
 * @public
 */
export interface SkillRegistryBundle {
  /** The merged SkillRegistry (base + extras), ready for OODA phase injection. */
  registry: SkillRegistry;
  /** Names of the base skills always included. */
  baseNames: readonly string[];
  /** Names of the domain extras merged in. */
  extraNames: readonly string[];
}

// ─── Zod validation schema ────────────────────────────────────────────────────
// NOTE: `deps` is intentionally excluded from this schema — it contains complex
// runtime objects (BrainPort, LoggerPort) that are not Zod-serializable.
// We validate only the primitive + serializable fields.

const buildSkillsOptionsSchema = z.object({
  agentId: z.string().min(1),
  domain: z.string().min(1),
  extras: z
    .array(
      z.object({
        name: z.string().min(1),
        skill: z.unknown(),
      }),
    )
    .optional(),
});

// ─── llm-complete factory ─────────────────────────────────────────────────────

/**
 * Build the `llm-complete` skill bound to the provided LiteLLM config.
 * Produces a Skill that calls the LiteLLM `/v1/chat/completions` endpoint.
 *
 * Defined inline rather than a separate file to keep the bound config local.
 */
function buildLlmCompleteSkill(deps: SkillBuilderDeps): Skill {
  type LlmInput = {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    maxTokens?: number;
  };
  type LlmOutput = { content: string; raw: unknown };

  const inputSchema = z
    .object({
      systemPrompt: z.string(),
      userPrompt: z.string(),
      model: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .strict();

  return {
    name: "llm-complete",
    inputSchema,
    async execute(input: LlmInput, ctx): Promise<LlmOutput> {
      if (ctx.isReplay) {
        const mock = ctx.dryRunMocks["llm-complete"];
        if (mock) return mock(input) as LlmOutput;
        return { content: "", raw: { replay: true } };
      }
      const litellmUrl = deps.litellmUrl ?? process.env.LITELLM_URL;
      const apiKey = deps.litellmApiKey ?? process.env.LITELLM_API_KEY ?? "sk-sdk";
      if (!litellmUrl) {
        deps.logger.warn?.({ skill: "llm-complete" }, "LITELLM_URL not configured");
        return { content: "", raw: { error: "LITELLM_URL not configured" } };
      }
      try {
        const res = await fetch(`${litellmUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: input.model ?? "forge-orient",
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPrompt },
            ],
            max_tokens: input.maxTokens ?? 1024,
            temperature: 0.3,
          }),
        });
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        if (!content) {
          deps.logger.error?.({ skill: "llm-complete", data }, "empty response content");
        }
        return { content, raw: data };
      } catch (err) {
        deps.logger.error?.({ skill: "llm-complete", err }, "fetch failed");
        return { content: "", raw: { error: String(err) } };
      }
    },
  } satisfies Skill;
}

// ─── Main factory ─────────────────────────────────────────────────────────────

/**
 * Build a SkillRegistry for an agent.
 *
 * Base skills (always included): brain-store, brain-query, slack-notify, llm-complete.
 * Domain extras are merged on top — Zod validation prevents duplicate IDs.
 *
 * @example
 * ```ts
 * const { registry } = buildSkills({
 *   agentId: "forge-revenue",
 *   deps,
 *   domain: "revenue",
 *   extras: [{ name: "http-fetch", skill: httpFetch }],
 * });
 * ```
 *
 * @throws {z.ZodError} if options fail validation
 * @throws {Error} if extras contain a skill ID that collides with a base skill name
 * @public
 */
export function buildSkills(opts: BuildSkillsOptions): SkillRegistryBundle {
  // Validate serializable fields only (deps excluded — contains non-serializable ports)
  buildSkillsOptionsSchema.parse({
    agentId: opts.agentId,
    domain: opts.domain,
    extras: opts.extras,
  });

  const { deps, extras = [] } = opts;

  // Check for duplicate IDs (extras must not shadow base skills)
  const baseName = new Set<string>(BASE_SKILL_NAMES);
  for (const { name } of extras) {
    if (baseName.has(name)) {
      throw new Error(
        `buildSkills: extra skill "${name}" collides with a base skill name. Base skills: ${[...baseName].join(", ")}. To override a base skill, use a different name or extend the registry manually.`,
      );
    }
  }

  // Check for duplicate extra names
  const extraNames = extras.map((e) => e.name);
  const uniqueExtras = new Set(extraNames);
  if (uniqueExtras.size !== extraNames.length) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of extraNames) {
      if (seen.has(n)) dupes.push(n);
      else seen.add(n);
    }
    throw new Error(`buildSkills: duplicate extra skill IDs detected: ${dupes.join(", ")}`);
  }

  // Assemble base registry
  const base: SkillRegistry = {
    "brain-store": brainStore,
    "brain-query": brainQuery,
    "slack-notify": slackNotify,
    "llm-complete": buildLlmCompleteSkill(deps),
  };

  // Merge extras
  const registry: SkillRegistry = { ...base };
  for (const { name, skill } of extras) {
    registry[name] = skill;
  }

  return {
    registry,
    baseNames: [...BASE_SKILL_NAMES],
    extraNames,
  };
}

/**
 * Convenience: extract just the SkillRegistry from `buildSkills`.
 * Identical to `buildSkills(opts).registry`.
 * @public
 */
export function buildSkillRegistry(opts: BuildSkillsOptions): SkillRegistry {
  return buildSkills(opts).registry;
}

// Re-export for convenience
export { httpFetch };
export type { DomainSkillEntry };
