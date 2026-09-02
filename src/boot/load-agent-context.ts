/**
 * loadAgentContext — Brain context loading at agent boot.
 *
 * Promoted from forge/src/agents/shared/startup.ts (Vague 1.B.2).
 * Forge-specific coupling neutralized:
 * - "FORGE.md" hardcoded string → parameterizable via `projectMd` option
 * - forge_config / forge_decision categories → parameterizable
 *
 * @public @since 0.17.0
 */

import type { BrainEntry, BrainPort } from "../ports/brain.js";
import type { LoggerPort } from "../ports/logger.js";

// ─── AgentContext ─────────────────────────────────────────────────────────────

/**
 * Context loaded from Brain at agent boot.
 *
 * @public
 */
export interface AgentContext {
  /** Content of the project markdown document (e.g. FORGE.md), or null if not found. */
  projectMdContent: string | null;
  /** Recent decisions relevant to this agent's domain. */
  recentDecisions: Array<{ content: string; created_at?: string }>;
  /** Domain-specific context entries. */
  domainContext: Array<{ content: string; created_at?: string }>;
}

// ─── LoadAgentContextOptions ──────────────────────────────────────────────────

/**
 * Options for loadAgentContext.
 *
 * @public
 */
export interface LoadAgentContextOptions {
  /**
   * Brain query string + category tag for the project markdown document.
   * Example: `{ query: "FORGE.md 0-Employee Business OS", category: "forge_config", tag: "forge-md" }`
   * When omitted, no projectMd query is performed.
   */
  projectMd?: {
    /** FTS query string for the project markdown. */
    query: string;
    /** Brain category for the project markdown entry. */
    category: string;
    /** Brain tag for the project markdown entry. */
    tag: string;
  };
  /** Category to use when querying recent decisions (default: "decision"). */
  decisionsCategory?: string;
  /** Maximum number of recent decisions to load (default: 10). */
  recentDecisionsLimit?: number;
  /** Domain tag categories for context loading (default: ["context"]). */
  domainCategories?: string[];
  /** Maximum number of domain context entries to load (default: 20). */
  domainContextLimit?: number;
}

// ─── loadAgentContext ─────────────────────────────────────────────────────────

/**
 * Load agent context from Brain at boot.
 *
 * Three queries:
 * 1. Optional project markdown document (e.g. FORGE.md, CLAUDE.md)
 * 2. Recent decisions for the agent's domain tags
 * 3. Domain-specific context entries
 *
 * All queries are non-fatal — failures log a warning and return empty data.
 * This ensures agents can boot even when Brain is temporarily unavailable.
 *
 * @example
 * ```ts
 * const ctx = await loadAgentContext(brain, "forge-revenue", ["revenue", "gtm"], logger, {
 *   projectMd: { query: "FORGE.md 0-Employee Business OS", category: "forge_config", tag: "forge-md" },
 *   decisionsCategory: "forge_decision",
 * });
 * ```
 *
 * @public
 */
export async function loadAgentContext(
  brain: BrainPort,
  agentId: string,
  domainTags: string[],
  logger: LoggerPort,
  opts: LoadAgentContextOptions = {},
): Promise<AgentContext> {
  const {
    projectMd,
    decisionsCategory = "decision",
    recentDecisionsLimit = 10,
    domainContextLimit = 20,
  } = opts;

  let projectMdContent: string | null = null;
  let recentDecisions: Array<{ content: string; created_at?: string }> = [];
  let domainContext: Array<{ content: string; created_at?: string }> = [];

  // Query 1: project markdown (optional)
  if (projectMd) {
    try {
      const entries = await brain.queryKnowledge?.(projectMd.query, {
        category: projectMd.category,
        tags: [projectMd.tag],
        limit: 1,
      });
      if (entries && entries.length > 0) {
        projectMdContent = entries[0]?.content ?? null;
      }
    } catch (err) {
      logger.warn({ err }, `[${agentId}] Failed to load project markdown from Brain`);
    }
  }

  // Query 2: recent decisions
  try {
    const decisions = await brain.queryKnowledge?.(`recent decisions ${domainTags.join(" ")}`, {
      category: decisionsCategory,
      tags: domainTags,
      limit: recentDecisionsLimit,
    });
    recentDecisions = (decisions ?? []).map((e: BrainEntry) => ({
      content: e.content,
      created_at: e.created_at,
    }));
  } catch (err) {
    logger.warn({ err }, `[${agentId}] Failed to load recent decisions`);
  }

  // Query 3: domain context
  try {
    const context = await brain.queryKnowledge?.(`${agentId} domain context`, {
      tags: [agentId, ...domainTags],
      limit: domainContextLimit,
    });
    domainContext = (context ?? []).map((e: BrainEntry) => ({
      content: e.content,
      created_at: e.created_at,
    }));
  } catch (err) {
    logger.warn({ err }, `[${agentId}] Failed to load domain context`);
  }

  logger.info(
    {
      projectMdLoaded: projectMdContent !== null,
      decisions: recentDecisions.length,
      context: domainContext.length,
    },
    `[${agentId}] Context loaded`,
  );

  return { projectMdContent, recentDecisions, domainContext };
}
