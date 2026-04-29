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

export interface CoherenceDetector {
  check(
    recentToolCalls: Array<{ name: string; args: unknown }>,
    stepsWithoutTool: number,
  ): { isLoop: boolean; isStall: boolean; score: number };
}

export type LogMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
};

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_BUDGET: AgentBudgetState = {
  stepCount: 0,
  maxSteps: 20,
  tokensBudget: { input: 200_000, output: 50_000, usedInput: 0, usedOutput: 0 },
  contextWindow: { maxTokens: 200_000, currentTokens: 0 },
  compactionTrigger: 15,
  coherenceScore: 1,
};

export function createBudgetState(
  overrides?: Partial<AgentBudgetState>,
): AgentBudgetState {
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
    compactionTrigger:
      overrides?.compactionTrigger ?? DEFAULT_BUDGET.compactionTrigger,
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
 */
export function createCoherenceDetector(config?: {
  loopDetectionWindow?: number;
  stallThreshold?: number;
}): CoherenceDetector {
  const window = config?.loopDetectionWindow ?? 3;
  const stallThreshold = config?.stallThreshold ?? 5;

  if (window < 2) {
    throw new Error(
      "createCoherenceDetector: loopDetectionWindow must be >= 2",
    );
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

function detectLoop(
  calls: Array<{ name: string; args: unknown }>,
  windowSize: number,
): boolean {
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
 */
export async function emergencyContextSummary(
  log: LogMessage[],
  summarize: (prompt: string) => Promise<string>,
  opts: { recursion: false },
): Promise<string> {
  if (opts.recursion !== false) {
    throw new Error(
      "emergencyContextSummary: recursion guard hit — opts.recursion must be false",
    );
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
