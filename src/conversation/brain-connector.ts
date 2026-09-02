import type { SemanticMemoryPort } from "../ports/brain.js";
import type { CompactionLLMFn } from "./context.js";

/**
 * Wraps a local CompactionLLMFn to additionally archive compaction summaries
 * to Brain (SemanticMemoryPort) after each compact() call.
 *
 * Brain archival is always fail-soft: if Brain is unavailable, the summary
 * is still returned to the caller — the compact never fails due to Brain.
 *
 * @param semanticMemory - Brain SemanticMemoryPort implementation
 * @param localLlmFn - Local LLM function (always called first)
 * @param sessionTag - Tag used to group summaries per session (e.g. runId)
 * @public
 */
export function createBrainCompactionLlmFn(
  semanticMemory: SemanticMemoryPort,
  localLlmFn: CompactionLLMFn,
  sessionTag: string,
): CompactionLLMFn {
  return async (prompt: string): Promise<string> => {
    const summary = await localLlmFn(prompt);
    // Fail-soft: never throw if Brain is unavailable
    try {
      await semanticMemory.archive({
        content: summary,
        category: "session-compaction",
        tags: ["session-compaction", sessionTag],
        confidence: 0.9,
      });
    } catch {
      // Brain unavailable — summary still returned
    }
    return summary;
  };
}

/**
 * Restore prior session context from Brain.
 * Queries Brain for recent compaction summaries tagged with sessionTag or
 * the generic "session-compaction" category. Returns a formatted string
 * suitable for injection as a system prompt prefix, or null if nothing found.
 *
 * Routes through SemanticMemoryPort.recall() (BrainRecallPort, ADR-ECO-065)
 * when available — tier:'fast' (single-hop GET /api/knowledge, tag-filtered,
 * no agentic multi-hop overhead). Falls back to .query() when recall() is
 * absent (backward-compat with non-BrainHttpClient implementations).
 *
 * Always fail-soft: returns null on any error.
 *
 * @param semanticMemory - Brain SemanticMemoryPort implementation
 * @param sessionTag - Tag to filter summaries (e.g. agent runId or project slug)
 * @param limit - Max number of prior summaries to include (default: 5)
 * @public
 */
export async function restoreSessionContext(
  semanticMemory: SemanticMemoryPort,
  sessionTag: string,
  limit = 5,
): Promise<string | null> {
  try {
    let contents: string[];

    if (typeof semanticMemory.recall === "function") {
      // Port-aligned path (ADR-ECO-065): use tier:'fast' for a targeted
      // tag-filtered single-hop fetch — NOT 'agentic' (no multi-hop router
      // overhead needed for deterministic session-restore by tag).
      const result = await semanticMemory.recall("session-compaction", {
        tier: "fast",
        tags: ["session-compaction", sessionTag],
        topK: limit,
        mode: "chunks",
      });
      contents = result.chunks.map((c) => c.content);
    } else {
      // Legacy fallback: implementations that do not expose recall() (e.g.
      // custom SemanticMemoryPort impls that only implement query/archive).
      const entries = await semanticMemory.query("session-compaction", {
        tags: ["session-compaction", sessionTag],
        limit,
      });
      contents = entries.map((e) => e.content);
    }

    if (contents.length === 0) return null;
    const body = contents.join("\n\n---\n\n");
    return `## Long-term context (from prior sessions)\n\n${body}`;
  } catch {
    return null;
  }
}
