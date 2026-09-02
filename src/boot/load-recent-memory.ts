/**
 * loadRecentMemory — load recent agent outcomes from Brain at boot.
 *
 * Promoted from forge/src/agents/shared/startup.ts (Vague 1.B.2).
 * Forge-specific coupling neutralized:
 * - "forge_outcome" category → parameterizable
 * - "forge" tag → parameterizable
 *
 * T0 stable block (ADR-ECO-065, sprint-805 Task 2):
 * `buildT0MemoryBlock` produces a CACHEABLE prefix summary from Brain entries.
 * CACHE-SAFETY INVARIANT: T0 = stable/cacheable; per-query dynamic recall =
 * dynamic orient zone only. The two MUST NOT be mixed.
 *
 * @public @since 0.17.0
 */

import type { BrainEntry, BrainPort } from "../ports/brain.js";

// ─── LoadRecentMemoryOptions ─────────────────────────────────────────────────

/**
 * Options for loadRecentMemory.
 *
 * @public
 */
export interface LoadRecentMemoryOptions {
  /** Brain category for outcome entries (default: "outcome"). */
  category?: string;
  /** Additional tags to filter entries (default: [agentId]). */
  tags?: string[];
  /** Maximum number of entries to load (default: 5). */
  limit?: number;
  /** Maximum total characters for the returned summary (default: 2000). */
  maxChars?: number;
  /** Maximum characters per entry preview (default: 300). */
  maxEntryChars?: number;
}

// ─── T0StableMemoryBlock ──────────────────────────────────────────────────────

/**
 * A cacheable T0 prefix block built from stable, query-independent Brain entries.
 *
 * CACHE-SAFETY INVARIANT (Brain a8e8423a / arXiv:2601.06007):
 *   T0 content is fetched ONCE at agent boot and MUST NOT change between cycles.
 *   It is safe to place in a cacheable system-prompt prefix.
 *   Per-query dynamic recall (`renderMemoryContext`) MUST remain in the dynamic
 *   orient USER zone — NEVER merged into this block.
 *
 * @public
 */
export interface T0StableMemoryBlock {
  /**
   * Ready-to-embed cacheable prefix string for the agent system prompt.
   * Empty string when Brain is unavailable or no entries exist — never null.
   * Wrapped in `<stable_memory>` XML tags for clear boundary marking.
   */
  readonly text: string;
  /** Number of entries loaded (0 when Brain unavailable or no entries). */
  readonly entryCount: number;
  /** ISO timestamp of when the block was assembled (for cache-key tracking). */
  readonly assembledAt: string;
}

/**
 * Options for buildT0MemoryBlock.
 *
 * @public
 */
export interface T0StableMemoryBlockOptions {
  /**
   * Brain categories to include in the stable block (default: ["decision", "pattern"]).
   * Use stable, slow-moving categories only — outcomes are NOT appropriate here
   * (they change every cycle and would break cache safety).
   */
  categories?: string[];
  /** Tags to filter entries (default: [agentId]). */
  tags?: string[];
  /** Maximum entries per category (default: 3). */
  limitPerCategory?: number;
  /** Maximum total characters for the block (default: 3000). */
  maxChars?: number;
  /** Maximum characters per entry preview (default: 400). */
  maxEntryChars?: number;
}

// ─── loadRecentMemory ────────────────────────────────────────────────────────

/**
 * Load recent outcomes for an agent from Brain and return a concise text summary.
 *
 * Returns an empty string when Brain is unavailable or no entries exist —
 * never throws, so agents can boot even when Brain is temporarily down.
 *
 * @example
 * ```ts
 * const memory = await loadRecentMemory(brain, "forge-revenue", {
 *   category: "forge_outcome",
 *   tags: ["forge", "agent:forge-revenue", "outcome"],
 * });
 * // → "2026-05-07: Revenue cycle completed: 3 leads qualified...\n..."
 * ```
 *
 * @public
 */
export async function loadRecentMemory(
  brain: BrainPort,
  agentId: string,
  opts: LoadRecentMemoryOptions = {},
): Promise<string> {
  const { category = "outcome", tags, limit = 5, maxChars = 2000, maxEntryChars = 300 } = opts;

  const effectiveTags = tags ?? [agentId];

  let entries: BrainEntry[] = [];
  try {
    entries =
      (await brain.queryKnowledge?.("recent outcomes", {
        category,
        tags: effectiveTags,
        limit,
      })) ?? [];
  } catch {
    // Non-fatal: agent can still boot without memory
    return "";
  }

  return entries
    .map((e) => {
      const date = e.created_at ?? "unknown";
      const preview =
        e.content.length > maxEntryChars ? `${e.content.slice(0, maxEntryChars)}...` : e.content;
      return `${date}: ${preview}`;
    })
    .join("\n")
    .slice(0, maxChars);
}

// ─── buildT0MemoryBlock ───────────────────────────────────────────────────────

/**
 * Build a T0 STABLE, CACHEABLE memory block from Brain at agent boot.
 *
 * Fetches stable, slow-moving Brain entries (decisions, patterns) to produce a
 * prefix block suitable for embedding in a cacheable system prompt. This block
 * MUST NOT contain per-query or per-cycle content.
 *
 * CACHE-SAFETY INVARIANT: this block is only safe to cache because it uses
 * categories that change on a weekly/monthly cadence. Do NOT include "outcome"
 * entries (per-cycle) or query-specific recall results (dynamic) here.
 * Per-query recall belongs in the dynamic orient zone via `renderMemoryContext`.
 *
 * Returns an empty-text block when Brain is unavailable — never throws.
 *
 * @example
 * ```ts
 * const t0 = await buildT0MemoryBlock(brain, "trading-nq", {
 *   categories: ["decision", "pattern"],
 *   tags: ["trading-nq"],
 * });
 * // Embed t0.text into the system prompt prefix (cacheable).
 * // Per-query recall is injected separately via renderMemoryContext().
 * ```
 *
 * @public
 */
export async function buildT0MemoryBlock(
  brain: BrainPort,
  agentId: string,
  opts: T0StableMemoryBlockOptions = {},
): Promise<T0StableMemoryBlock> {
  const {
    categories = ["decision", "pattern"],
    tags,
    limitPerCategory = 3,
    maxChars = 3000,
    maxEntryChars = 400,
  } = opts;

  const effectiveTags = tags ?? [agentId];
  const allEntries: Array<{ category: string; entry: BrainEntry }> = [];

  for (const cat of categories) {
    let entries: BrainEntry[] = [];
    try {
      entries =
        (await brain.queryKnowledge?.(`${agentId} ${cat}`, {
          category: cat,
          tags: effectiveTags,
          limit: limitPerCategory,
        })) ?? [];
    } catch {
      // Non-fatal: skip this category, continue with others.
    }
    for (const entry of entries) {
      allEntries.push({ category: cat, entry });
    }
  }

  if (allEntries.length === 0) {
    return {
      text: "",
      entryCount: 0,
      assembledAt: new Date().toISOString(),
    };
  }

  const lines: string[] = ["<stable_memory>"];

  let totalChars = "<stable_memory>\n".length + "\n</stable_memory>".length;
  let included = 0;

  for (const { category: cat, entry: e } of allEntries) {
    const date = e.created_at ?? "unknown";
    const preview =
      e.content.length > maxEntryChars ? `${e.content.slice(0, maxEntryChars)}...` : e.content;
    const line = `[${cat}] ${date}: ${preview}`;
    const lineBytes = line.length + 1; // +1 for newline
    if (totalChars + lineBytes > maxChars) break;
    lines.push(line);
    totalChars += lineBytes;
    included++;
  }

  lines.push("</stable_memory>");
  const text = lines.join("\n");

  return {
    text,
    entryCount: included,
    assembledAt: new Date().toISOString(),
  };
}
