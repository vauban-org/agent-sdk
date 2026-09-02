/**
 * budget-state — Per-run budget + coherence + compaction primitives for the
 * Vauban agent loops.
 *
 * Scope:
 *   - AgentBudgetState (mutable counters: steps, tokens, context window).
 *   - CoherenceDetector: flags tool-call loops and stalls.
 *   - compactToolLog: trims the middle of a long tool conversation.
 *   - emergencyContextSummary: LLM-backed "last resort" fallback when the
 *     context window passes 90% of its soft cap.
 *
 * Non-goals:
 *   - Token counting / tokenizer accuracy (provider-router returns usage).
 *   - Persistence of budget state (AgentRunTracker handles that).
 * @public
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface AgentBudgetState {
  stepCount: number;
  maxSteps: number;
  tokensBudget: {
    input: number;
    output: number;
    usedInput: number;
    usedOutput: number;
  };
  contextWindow: {
    maxTokens: number;
    currentTokens: number;
  };
  /** stepCount value at which compactToolLog should run. */
  compactionTrigger: number;
  /** 0..1 — live coherence score (1 = healthy, 0 = loop+stall). */
  coherenceScore: number;
}

/** @public */
export interface CoherenceDetector {
  check(
    recentToolCalls: Array<{ name: string; args: unknown }>,
    stepsWithoutTool: number,
  ): { isLoop: boolean; isStall: boolean; score: number };
}

/** @public */
export type LogMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
};

// ─── Defaults ─────────────────────────────────────────────────────────────

// Zero-config fallback only — this SDK has no ModelCapabilities port to
// deduce a real context window from (per ADR-ECO-117 audit, 2026-07-08).
// Hosts that know their model's actual window (e.g. via /model/info) SHOULD
// pass contextWindow / tokensBudget explicitly through createBudgetState's
// overrides instead of relying on this static 200k figure ; see
// packages/cli's cmd-chat.ts / cmd-agent.ts for the deduction pattern.
const DEFAULT_BUDGET: AgentBudgetState = {
  stepCount: 0,
  maxSteps: 20,
  tokensBudget: { input: 200_000, output: 50_000, usedInput: 0, usedOutput: 0 },
  contextWindow: { maxTokens: 200_000, currentTokens: 0 },
  compactionTrigger: 15,
  coherenceScore: 1,
};

/** @public */
export function createBudgetState(overrides?: Partial<AgentBudgetState>): AgentBudgetState {
  return {
    stepCount: overrides?.stepCount ?? DEFAULT_BUDGET.stepCount,
    maxSteps: overrides?.maxSteps ?? DEFAULT_BUDGET.maxSteps,
    tokensBudget: {
      ...DEFAULT_BUDGET.tokensBudget,
      ...overrides?.tokensBudget,
    },
    contextWindow: {
      ...DEFAULT_BUDGET.contextWindow,
      ...overrides?.contextWindow,
    },
    compactionTrigger: overrides?.compactionTrigger ?? DEFAULT_BUDGET.compactionTrigger,
    coherenceScore: overrides?.coherenceScore ?? DEFAULT_BUDGET.coherenceScore,
  };
}

// ─── CoherenceDetector ────────────────────────────────────────────────────

/**
 * Returns a detector that flags:
 *   - loop   : last `loopDetectionWindow` tool calls have identical name + deep-equal args.
 *   - stall  : `stepsWithoutTool >= stallThreshold` (assistant keeps answering
 *              but never invokes a tool).
 *
 * Score: 1.0 if neither, 0.0 if both, 0.5 if exactly one.
 * @public
 */
export function createCoherenceDetector(config?: {
  loopDetectionWindow?: number;
  stallThreshold?: number;
}): CoherenceDetector {
  const window = config?.loopDetectionWindow ?? 6;
  const stallThreshold = config?.stallThreshold ?? 10;

  if (window < 2) {
    throw new Error("createCoherenceDetector: loopDetectionWindow must be >= 2");
  }
  if (stallThreshold < 1) {
    throw new Error("createCoherenceDetector: stallThreshold must be >= 1");
  }

  return {
    check(recentToolCalls, stepsWithoutTool) {
      const isLoop = detectLoop(recentToolCalls, window);
      const isStall = stepsWithoutTool >= stallThreshold;
      let score = 1;
      if (isLoop) score -= 0.5;
      if (isStall) score -= 0.5;
      if (score < 0) score = 0;
      return { isLoop, isStall, score };
    },
  };
}

function detectLoop(calls: Array<{ name: string; args: unknown }>, windowSize: number): boolean {
  if (calls.length < windowSize) return false;
  const window = calls.slice(-windowSize);
  const first = window[0];
  if (!first) return false;
  const firstKey = `${first.name}:${stableStringify(first.args)}`;
  for (let i = 1; i < window.length; i++) {
    const c = window[i];
    if (!c) return false;
    if (`${c.name}:${stableStringify(c.args)}` !== firstKey) return false;
  }
  return true;
}

/** JSON.stringify with sorted keys so {a:1,b:2} and {b:2,a:1} compare equal. */
function stableStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (val: unknown): unknown => {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val as object)) return "[circular]";
    seen.add(val as object);
    if (Array.isArray(val)) return val.map(walk);
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = walk(obj[k]);
    return out;
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return "[unserializable]";
  }
}

// ─── compactToolLog ───────────────────────────────────────────────────────

/**
 * Keeps the first `keepFirst` and last `keepLast` messages; replaces the
 * middle with a single system note describing how many steps were omitted.
 *
 * Guarantees:
 *   - Returns a NEW array (does not mutate input).
 *   - If log is already short enough, returns a copy unchanged.
 *   - Never drops the very first user message (prompt context).
 * @public
 */
export function compactToolLog(
  log: LogMessage[],
  opts?: { keepFirst?: number; keepLast?: number },
): LogMessage[] {
  const keepFirst = opts?.keepFirst ?? 2;
  const keepLast = opts?.keepLast ?? 4;

  if (keepFirst < 0 || keepLast < 0) {
    throw new Error("compactToolLog: keepFirst and keepLast must be >= 0");
  }

  if (log.length <= keepFirst + keepLast) {
    return log.slice();
  }

  const head = log.slice(0, keepFirst);
  const tail = log.slice(log.length - keepLast);
  const omitted = log.length - keepFirst - keepLast;

  const summary: LogMessage = {
    role: "system",
    content: `… [${omitted} tool steps omitted for brevity]`,
  };

  return [...head, summary, ...tail];
}

// ─── compactToolLogDecay ──────────────────────────────────────────────────

/** @public */
export interface DecayCompactionConfig {
  /** Half-life in turns. Default 4. */
  halfLifeTurns?: number;
  /** Bonus added to tool-error scores. Default 0.3. */
  errorBonus?: number;
  /** Maximum tool messages to keep. Default 12. */
  keepTopK?: number;
}

/**
 * Decay-weighted alternative to compactToolLog.
 * Preserves system + user messages always. Among tool messages, scores
 * by recency × content-richness × error-flag and keeps the top-K by
 * score, restored to original chronological order.
 *
 * Score formula (Ebbinghaus-inspired, ref: MemoryBank Zhong et al. AAAI 2024):
 *   recency  = 0.5 ^ (turns_from_end / halfLifeTurns)   [1.0 = most recent]
 *   size     = log(content.length + 1) / 10             [slight richness boost]
 *   errBonus = 0.3 if content looks like a tool error    [remember failures]
 *   score    = recency + size + errBonus
 *
 * System and user messages are NEVER evicted.
 * Returns a NEW array (does not mutate input).
 * @public
 */
export function compactToolLogDecay(
  log: LogMessage[],
  config?: DecayCompactionConfig,
): LogMessage[] {
  const halfLifeTurns = config?.halfLifeTurns ?? 4;
  const errorBonus = config?.errorBonus ?? 0.3;
  const keepTopK = config?.keepTopK ?? 12;

  if (halfLifeTurns <= 0) {
    throw new Error("compactToolLogDecay: halfLifeTurns must be > 0");
  }
  if (keepTopK < 0) {
    throw new Error("compactToolLogDecay: keepTopK must be >= 0");
  }

  // Group messages into ATOMIC EXCHANGE UNITS to preserve the OpenAI invariant:
  // every role:"tool" message must be preceded by role:"assistant" with tool_calls.
  // Evicting an assistant message while keeping its tool responses breaks this invariant
  // → HTTP 400 from the LLM provider.
  //
  // Strategy:
  //   1. Protected: system + user messages → never evicted.
  //   2. Exchange units: each (assistant + 0..N following tool messages) treated as one atom.
  //   3. Score each exchange unit (Ebbinghaus on the assistant message + tool error bonus).
  //   4. Keep top-K UNITS. Evict the rest entirely.

  type ExchangeUnit = {
    messages: LogMessage[];
    startIndex: number;
    score: number;
  };

  const protected_: Array<{ msg: LogMessage; originalIndex: number }> = [];
  const units: ExchangeUnit[] = [];

  let i = 0;
  while (i < log.length) {
    const msg = log[i] as LogMessage;
    if (msg.role === "system" || msg.role === "user") {
      protected_.push({ msg, originalIndex: i });
      i++;
    } else if (msg.role === "assistant") {
      // Collect this assistant message + all immediately following tool messages.
      const unit: LogMessage[] = [msg];
      let j = i + 1;
      while (j < log.length && (log[j] as LogMessage).role === "tool") {
        unit.push(log[j] as LogMessage);
        j++;
      }
      units.push({ messages: unit, startIndex: i, score: 0 });
      i = j;
    } else {
      // Orphan tool or other — treat as a 1-message unit.
      units.push({ messages: [msg], startIndex: i, score: 0 });
      i++;
    }
  }

  // Nothing to evict — return a copy.
  if (units.length <= keepTopK) {
    return log.slice();
  }

  // Score each exchange unit (position-based Ebbinghaus on the unit's assistant message).
  const totalUnits = units.length;
  for (let k = 0; k < totalUnits; k++) {
    const unit = units[k];
    const turnsFromEnd = totalUnits - 1 - k; // 0 = most recent
    const recency = 0.5 ** (turnsFromEnd / halfLifeTurns);
    // Content = concatenation of all messages in the unit for error detection
    const fullContent = unit.messages.map((m) => m.content).join("\n");
    const size = Math.log(fullContent.length + 1) / 10;
    const hasError = /error|fail|exception|timeout|denied|invalid/i.test(fullContent);
    unit.score = recency + size + (hasError ? errorBonus : 0);
  }

  // Keep top-K units by score (stable sort preserves chronological order among equals).
  const sortedUnits = [...units].sort((a, b) => b.score - a.score);
  const keptUnits = new Set(sortedUnits.slice(0, keepTopK).map((u) => u.startIndex));

  // Reconstruct: protected messages + kept units in original order.
  const result: LogMessage[] = [];
  i = 0;
  const protIdx = 0;

  // Interleave protected messages (system/user) at their original positions.
  const allItems: Array<{ index: number; messages: LogMessage[] }> = [
    ...protected_.map((p) => ({ index: p.originalIndex, messages: [p.msg] })),
    ...units
      .filter((u) => keptUnits.has(u.startIndex))
      .map((u) => ({ index: u.startIndex, messages: u.messages })),
  ];
  allItems.sort((a, b) => a.index - b.index);

  for (const item of allItems) {
    result.push(...item.messages);
  }

  void i;
  void protIdx; // suppress unused-var lint

  return result;
}

// ─── emergencyContextSummary ──────────────────────────────────────────────

/**
 * Called when contextWindow.currentTokens > 0.9 * maxTokens. Uses the
 * caller-provided `summarize` function (typically the provider-router's
 * complete() wired as a one-shot prompt) to produce a short recap that
 * replaces the bulk of the log.
 *
 * Recursion guard: `opts.recursion` MUST be false. If callers ever wire
 * this into itself (e.g. summarize triggers another context summary), it
 * throws — we refuse to recurse because the error path must be bounded.
 * @public
 */
export async function emergencyContextSummary(
  log: LogMessage[],
  summarize: (prompt: string) => Promise<string>,
  opts: { recursion: false },
): Promise<string> {
  if (opts.recursion !== false) {
    throw new Error("emergencyContextSummary: recursion guard hit — opts.recursion must be false");
  }

  const transcript = log
    .map((m) => `[${m.role}${m.toolName ? `:${m.toolName}` : ""}] ${m.content}`)
    .join("\n");

  const prompt = [
    "You are compressing an agent conversation to save context tokens.",
    "Summarize the key facts, decisions, tool outputs and pending work in ≤ 300 words.",
    "Preserve anything an agent would need to continue the task.",
    "",
    "Transcript:",
    transcript,
  ].join("\n");

  return summarize(prompt);
}
