import type { AgentBudgetState, LogMessage } from "../budget/budget-state.js";

/** @public @experimental */
export interface CompactorConfig {
  /** Window fill ratio that triggers compaction. Default 0.7. */
  threshold?: number;
  /** Fill ratio for the aggressive (emergency) pass. Default 0.9. */
  emergencyThreshold?: number;
  /** Recent messages kept verbatim. Default 6 (forced to 2 in emergency). */
  keepLast?: number;
  /** Map a log message to its journal stepIndex (WeakMap-backed in the loop). */
  indexFor?: (msg: LogMessage) => number | undefined;
}

/** @public @experimental */
export interface CompactionOutcome {
  compacted: boolean;
  mode: "llm" | "deterministic" | "none";
  log: LogMessage[];
}

const CHARS_PER_TOKEN = 4;

function estimateLogTokens(log: LogMessage[]): number {
  let chars = 0;
  for (const m of log) chars += m.content.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Non-destructive window compactor. Every evicted message is expected to be
 * ALREADY journaled (journal-first invariant); the summary block carries an
 * index so the model can recall() any evicted step. The deterministic
 * fallback never throws: the class of run-death where the emergency
 * summarizer itself fails disappears (spec §5).
 * @public @experimental
 */
export function createCompactor(config?: CompactorConfig) {
  const threshold = config?.threshold ?? 0.7;
  const emergencyThreshold = config?.emergencyThreshold ?? 0.9;
  const keepLastNormal = config?.keepLast ?? 6;

  async function maybeCompact(
    log: LogMessage[],
    budget: AgentBudgetState,
    llmFn: (prompt: string) => Promise<string>,
    indexFor?: (msg: LogMessage) => number | undefined,
  ): Promise<CompactionOutcome> {
    const idxFn = indexFor ?? config?.indexFor;
    const { maxTokens } = budget.contextWindow;
    if (maxTokens <= 0) return { compacted: false, mode: "none", log };
    const ratio = estimateLogTokens(log) / maxTokens;
    if (ratio < threshold) return { compacted: false, mode: "none", log };
    const keepLast = ratio >= emergencyThreshold ? 2 : keepLastNormal;

    // Protected head: leading system messages + the first user message.
    let headEnd = 0;
    while (headEnd < log.length && log[headEnd]?.role === "system") headEnd++;
    if (log[headEnd]?.role === "user") headEnd++;

    const tailStart = Math.max(headEnd, log.length - keepLast);
    const evictable = log.slice(headEnd, tailStart);
    if (evictable.length === 0) return { compacted: false, mode: "none", log };

    const index = evictable.map((m) => {
      const idx = idxFn?.(m);
      const firstLine = m.content.split("\n")[0]?.slice(0, 80) ?? "";
      const label = m.toolName ? `${m.role}:${m.toolName}` : m.role;
      return idx !== undefined
        ? `- step ${idx} [${label}] ${firstLine}`
        : `- [${label}] ${firstLine} (not journaled : unrecoverable)`;
    });

    let summaryBody: string;
    let mode: "llm" | "deterministic";
    try {
      const transcript = evictable
        .map((m) => `[${m.role}${m.toolName ? `:${m.toolName}` : ""}] ${m.content}`)
        .join("\n");
      summaryBody = await llmFn(
        [
          "You are compressing an agent conversation to save context tokens.",
          "Summarize key facts, decisions, tool outputs and pending work in <= 300 words.",
          "Preserve anything the agent needs to continue the task.",
          "",
          transcript,
        ].join("\n"),
      );
      mode = "llm";
    } catch {
      summaryBody = "(summarizer unavailable : index only)";
      mode = "deterministic";
    }

    const summaryMsg: LogMessage = {
      role: "system",
      content: [
        "## Compacted context",
        summaryBody,
        "",
        "Evicted steps (use recall({steps:[i]}) or recall({query:...}) to re-read):",
        ...index,
      ].join("\n"),
    };
    const newLog = [...log.slice(0, headEnd), summaryMsg, ...log.slice(tailStart)];
    budget.contextWindow.currentTokens = estimateLogTokens(newLog);
    return { compacted: true, mode, log: newLog };
  }

  return { maybeCompact };
}

/** @public @experimental */
export type Compactor = ReturnType<typeof createCompactor>;
