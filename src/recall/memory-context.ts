/**
 * renderMemoryContext — deterministic <memory_context> block renderer.
 *
 * Promoted from apps/agents/forecaster/src/recall/memory-context.ts to SDK port
 * per ADR-ECO-065 (sprint-805 Stage 2).
 *
 * Invariant (docs/agentic-rag/cache-safety-invariant.md §1):
 *   Retrieved memory MUST appear in a dynamic block AFTER the cacheable prefix
 *   and BEFORE the user message. This function produces that block.
 *
 * Determinism contract:
 *   Given the same RecallChunk[], the output is byte-identical every call.
 *   Sort order: hybrid_score (desc), then id (asc) as tiebreaker.
 *   Chunks with a null hybrid_score sort last (treated as -Infinity), still
 *   deterministically ordered among themselves by id (asc).
 *   This guarantees that two workers processing the same retrieval result
 *   produce the same memory_context string — required for prompt-cache safety.
 *
 * @public
 */

import type { RecallChunk } from "./types.js";

// ─── Scoring helper ───────────────────────────────────────────────────────────

/**
 * Primary sort score = hybrid_score, with null treated as -Infinity so
 * unscored chunks sort to the end (deterministic, broken by id).
 */
function hybridScoreOrMin(c: RecallChunk): number {
  return c.hybrid_score != null ? c.hybrid_score : Number.NEGATIVE_INFINITY;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Render a deterministic `<memory_context>` XML block from retrieved chunks.
 *
 * Output format:
 *   <memory_context>
 *   <chunk id="<id>" score="<hybrid_score>"[ stale="true"]>
 *   <content><![CDATA[<content>]]></content>
 *   </chunk>
 *   ...
 *   </memory_context>
 *
 * - `score` is the chunk's hybrid_score formatted to 4 decimals, or "null"
 *   when absent.
 * - `stale="true"` is emitted when freshness data (Stage 3+) marks the chunk
 *   stale. Stage 0 chunks carry no freshness flag, so this attribute is absent.
 * - Empty chunks → `<memory_context></memory_context>`.
 * @public
 */
export function renderMemoryContext(chunks: readonly RecallChunk[]): string {
  if (chunks.length === 0) {
    return "<memory_context></memory_context>";
  }

  // Stable, deterministic sort: hybrid_score desc, then id asc (tiebreaker).
  // Compare via < / > (not subtraction) to stay correct for -Infinity.
  const sorted = [...chunks].sort((a, b) => {
    const sa = hybridScoreOrMin(a);
    const sb = hybridScoreOrMin(b);
    if (sb > sa) return 1;
    if (sb < sa) return -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const lines: string[] = ["<memory_context>"];

  for (const chunk of sorted) {
    const score = chunk.hybrid_score != null ? chunk.hybrid_score.toFixed(4) : "null";
    // Escape content for CDATA: ]]> is the only reserved sequence in CDATA.
    const safeContent = chunk.content.replace(/]]>/g, "]]]]><![CDATA[>");
    lines.push(`<chunk id="${chunk.id}" score="${score}">`);
    lines.push(`<content><![CDATA[${safeContent}]]></content>`);
    lines.push("</chunk>");
  }

  lines.push("</memory_context>");
  return lines.join("\n");
}
