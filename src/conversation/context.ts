/**
 * ConversationContext — tiered memory for multi-turn agent sessions.
 *
 * Two tiers:
 *  - Working memory: last `workingMemorySize` turns kept verbatim
 *  - Episodic memory: older turns replaced by LLM-generated summaries
 *
 * Strategy-aware output via toMessages(strategy):
 *  - "minimal" / "ooda": appends history as system suffix (backward-compat with renderHistorySuffix)
 *  - "react" / "plan": returns LLMMessage[] array with summaries as system prefix
 *  - "one-shot": returns []
 *
 * @public @since 2.3.0
 */

import type { AgentStrategyName } from "../strategies/index.js";
import type {
  CompactionReport,
  CompactionSummary,
  ConversationContextOpts,
  ConversationContextSnapshot,
  LLMMessage,
  Turn,
} from "./types.js";

/**
 * Completion function accepted by compact().
 * @public
 */
export type CompactionLLMFn = (prompt: string) => Promise<string>;

/**
 * Options for compact().
 * @public
 */
export interface CompactOpts {
  /** How many recent turns to keep verbatim. Defaults to workingMemorySize. */
  readonly keepLast?: number;
}

/** Default number of recent turns to keep verbatim. */
const DEFAULT_WORKING_MEMORY_SIZE = 6;

/**
 * Context window sizes for common models. Fallback: 32000.
 *
 * This is a zero-config FALLBACK for hosts that do not inject a resolver.
 * It necessarily drifts as new model families ship — hosts that can
 * deduce the real window (e.g. from a provider's `/model/info` endpoint,
 * see packages/cli/src/model-capabilities.ts for the pattern used by the
 * preste CLI) SHOULD inject `getContextWindow` via `ConversationContextOpts`
 * instead of relying on this table.
 */
const CONTEXT_WINDOW_MAP: Record<string, number> = {
  "claude-opus-4-7": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "deepseek-chat": 128000,
  "deepseek-r1": 128000,
  "deepseek-v3": 128000,
  "llama-3.3-70b": 128000,
  "llama-4-scout": 128000,
  "qwen3-8b": 32000,
  "qwq-32b": 32000,
  "gemini-2.0-flash": 1000000,
  "gemini-1.5-pro": 1000000,
};

function getContextWindow(model: string): number {
  return CONTEXT_WINDOW_MAP[model] ?? 32000;
}

/** @public */
export class ConversationContext {
  private readonly _workingMemorySize: number;
  private readonly _getContextWindow?: (model: string) => number;
  private _turns: Turn[];
  private _summaries: CompactionSummary[];

  constructor(opts: ConversationContextOpts = {}) {
    this._workingMemorySize = opts.workingMemorySize ?? DEFAULT_WORKING_MEMORY_SIZE;
    this._getContextWindow = opts.getContextWindow;
    this._turns = [];
    this._summaries = [];
  }

  // ─── Accessors ──────────────────────────────────────────────────────────────

  get turns(): readonly Turn[] {
    return this._turns;
  }

  get summaries(): readonly CompactionSummary[] {
    return this._summaries;
  }

  get turnCount(): number {
    return this._turns.length;
  }

  get workingMemorySize(): number {
    return this._workingMemorySize;
  }

  // ─── Core API ───────────────────────────────────────────────────────────────

  /**
   * Append a turn to the conversation.
   */
  addTurn(role: "user" | "assistant", content: string, meta?: Turn["meta"]): void {
    this._turns.push({
      role,
      content,
      ...(meta !== undefined ? { meta } : {}),
    });
  }

  /**
   * Return conversation history formatted for the given strategy.
   *
   * - "minimal" | "ooda": string suffix to append after system prompt
   * - "react" | "plan": LLMMessage[] array (system prefix + user/assistant)
   * - "one-shot": empty array
   *
   * @param strategy — agent strategy name
   * @param systemPrompt — base system prompt (used for "minimal"/"ooda" suffix mode)
   */
  toMessages(strategy: AgentStrategyName, systemPrompt?: string): string | LLMMessage[] {
    void systemPrompt;

    // Path C — one-shot: empty array
    if (strategy === "one-shot") {
      return [];
    }

    // Path B — react | plan: returns LLMMessage[]
    if (strategy === "react" || strategy === "plan") {
      const msgs: LLMMessage[] = [];
      if (this._summaries.length > 0) {
        const joined = this._summaries.map((s) => s.text).join("\n\n");
        msgs.push({
          role: "system",
          content: `## Summary of earlier conversation\n\n${joined}`,
        });
      }
      for (const turn of this._turns) {
        msgs.push({ role: turn.role, content: turn.content });
      }
      return msgs;
    }

    // Path A — ooda (and any future "minimal" alias): returns string
    // Identical output to renderHistorySuffix() in packages/cli/src/cmd-chat.ts
    if (this._turns.length === 0 && this._summaries.length === 0) {
      return "";
    }
    const lines: string[] = [];
    if (this._summaries.length > 0) {
      lines.push("## Summary of earlier conversation", "");
      for (const s of this._summaries) {
        lines.push(s.text, "");
      }
    }
    if (this._turns.length > 0) {
      lines.push("", "## Conversation so far", "");
      for (const turn of this._turns) {
        lines.push(`### ${turn.role === "user" ? "User" : "Assistant"}`);
        lines.push(turn.content);
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /**
   * Estimate token count across all turns + summaries.
   * Uses length/4 heuristic (characters → tokens).
   */
  estimatedTokens(): number {
    let total = 0;
    for (const turn of this._turns) {
      total += Math.ceil(turn.content.length / 4);
    }
    for (const summary of this._summaries) {
      total += Math.ceil(summary.text.length / 4);
    }
    return total;
  }

  /**
   * Compact the conversation: keep last `keepLast` turns verbatim,
   * summarize older turns via `llmFn`, return a CompactionReport.
   */
  async compact(llmFn: CompactionLLMFn, opts: CompactOpts = {}): Promise<CompactionReport> {
    const keepLast = opts.keepLast ?? this._workingMemorySize;
    const turnsBefore = this._turns.length;
    const tokensEstimatedBefore = this.estimatedTokens();

    if (turnsBefore <= keepLast) {
      return {
        turnsBefore,
        turnsAfter: turnsBefore,
        summariesAdded: 0,
        tokensEstimatedBefore,
        tokensEstimatedAfter: tokensEstimatedBefore,
      };
    }

    const olderTurns = this._turns.slice(0, turnsBefore - keepLast);
    const recentTurns = this._turns.slice(turnsBefore - keepLast);

    const originalTokens = Math.ceil(olderTurns.reduce((sum, t) => sum + t.content.length, 0) / 4);

    const dialogueLines = olderTurns.map((t, i) => {
      const speaker = t.role === "user" ? "User" : "Assistant";
      return `${i + 1}. ${speaker}: ${t.content}`;
    });
    const prompt = `Summarize the following conversation excerpt concisely, preserving key decisions, facts, and context. Output only the summary, no preamble.\n\n${dialogueLines.join("\n")}`;

    const summaryText = await llmFn(prompt);

    const newSummary: CompactionSummary = {
      createdAt: Date.now(),
      turnCount: olderTurns.length,
      originalTokens,
      text: summaryText,
    };

    this._summaries = [...this._summaries, newSummary];
    this._turns = recentTurns;

    return {
      turnsBefore,
      turnsAfter: this._turns.length,
      summariesAdded: 1,
      tokensEstimatedBefore,
      tokensEstimatedAfter: this.estimatedTokens(),
    };
  }

  /**
   * Compact if estimated fill ratio exceeds `threshold`.
   * Returns true if compaction was triggered.
   *
   * @param model — model identifier used to look up context window size
   * @param llmFn — LLM function for generating the summary
   * @param threshold — fill ratio threshold (default: 0.70)
   */
  async maybeCompact(model: string, llmFn: CompactionLLMFn, threshold = 0.7): Promise<boolean> {
    const baseModel = model.split("@")[0];
    const contextWindow = this._getContextWindow
      ? this._getContextWindow(baseModel)
      : getContextWindow(baseModel);
    const ratio = this.estimatedTokens() / contextWindow;
    if (ratio > threshold) {
      await this.compact(llmFn);
      return true;
    }
    return false;
  }

  /**
   * Serialize to a snapshot suitable for JSON.stringify / file persistence.
   */
  toJSON(): ConversationContextSnapshot {
    return {
      version: 1,
      workingMemorySize: this._workingMemorySize,
      turns: [...this._turns],
      summaries: [...this._summaries],
    };
  }

  /**
   * Reconstruct a ConversationContext from a snapshot.
   * Validates version field; throws on incompatible format.
   */
  static fromJSON(snapshot: ConversationContextSnapshot): ConversationContext {
    if (snapshot.version !== 1) {
      throw new Error(`ConversationContext: unsupported snapshot version ${snapshot.version}`);
    }
    const ctx = new ConversationContext({
      workingMemorySize: snapshot.workingMemorySize,
    });
    ctx._turns = [...snapshot.turns];
    ctx._summaries = [...snapshot.summaries];
    return ctx;
  }
}
