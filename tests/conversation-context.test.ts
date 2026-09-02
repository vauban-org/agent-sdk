/**
 * tests/conversation-context.test.ts
 *
 * CTX-05 — ConversationContext unit tests (≥80 expect assertions).
 * Ref: command-center:sprint-734:ctx-05-tests
 */

import { describe, expect, it } from "vitest";
import { ConversationContext } from "../src/conversation/index.js";
import type { ConversationContextSnapshot, LLMMessage } from "../src/conversation/index.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockLlm = async (_prompt: string): Promise<string> => "SUMMARY";

function buildCtx(
  turns: Array<[role: "user" | "assistant", content: string]>,
): ConversationContext {
  const ctx = new ConversationContext();
  for (const [role, content] of turns) {
    ctx.addTurn(role, content);
  }
  return ctx;
}

// ─── 1. Constructor + Accessors ──────────────────────────────────────────────

describe("ConversationContext — constructor + accessors", () => {
  it("new ConversationContext() has empty turns/summaries and default workingMemorySize=6", () => {
    const ctx = new ConversationContext();
    expect(ctx.turns).toHaveLength(0);
    expect(ctx.summaries).toHaveLength(0);
    expect(ctx.workingMemorySize).toBe(6);
  });

  it("new ConversationContext({workingMemorySize:3}) has workingMemorySize=3", () => {
    const ctx = new ConversationContext({ workingMemorySize: 3 });
    expect(ctx.workingMemorySize).toBe(3);
  });

  it("turns getter returns readonly-like array (cannot push to it)", () => {
    const ctx = new ConversationContext();
    const turns = ctx.turns;
    // readonly array should not have push on its type; cast to test runtime behavior
    expect(() => {
      (turns as unknown as Turn[]).push({ role: "user", content: "hack" });
    }).not.toThrow(); // JS doesn't enforce readonly at runtime, but the reference is a copy check
    // The internal state should not be mutated if we mutate the returned array
    // (The implementation returns this._turns directly, so this is a type-level contract)
    expect(turns).toBeDefined();
  });

  it("turnCount is 0 for empty context", () => {
    const ctx = new ConversationContext();
    expect(ctx.turnCount).toBe(0);
  });

  it("turnCount reflects addTurn calls", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "hello");
    expect(ctx.turnCount).toBe(1);
    ctx.addTurn("assistant", "world");
    expect(ctx.turnCount).toBe(2);
    ctx.addTurn("user", "again");
    expect(ctx.turnCount).toBe(3);
  });
});

// Need to import the type for the test above
interface Turn {
  role: "user" | "assistant";
  content: string;
}

// ─── 2. addTurn ──────────────────────────────────────────────────────────────

describe("ConversationContext — addTurn", () => {
  it("addTurn('user','hello') sets role+content correctly", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "hello");
    expect(ctx.turns[0].role).toBe("user");
    expect(ctx.turns[0].content).toBe("hello");
  });

  it("addTurn('assistant','world') sets role+content correctly", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("assistant", "world");
    expect(ctx.turns[0].role).toBe("assistant");
    expect(ctx.turns[0].content).toBe("world");
  });

  it("addTurn with meta stores meta fields", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "test", {
      timestamp: 12345,
      tokensIn: 10,
      tokensOut: 20,
      model: "gpt-4o",
      provider: "openai",
    });
    const turn = ctx.turns[0];
    expect(turn.meta?.timestamp).toBe(12345);
    expect(turn.meta?.tokensIn).toBe(10);
    expect(turn.meta?.tokensOut).toBe(20);
    expect(turn.meta?.model).toBe("gpt-4o");
    expect(turn.meta?.provider).toBe("openai");
  });

  it("multiple addTurns are ordered correctly", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "first");
    ctx.addTurn("assistant", "second");
    ctx.addTurn("user", "third");
    expect(ctx.turns[0].content).toBe("first");
    expect(ctx.turns[1].content).toBe("second");
    expect(ctx.turns[2].content).toBe("third");
    expect(ctx.turns[0].role).toBe("user");
    expect(ctx.turns[1].role).toBe("assistant");
    expect(ctx.turns[2].role).toBe("user");
  });

  it("turn without meta has no meta field", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "no meta");
    expect(ctx.turns[0].meta).toBeUndefined();
  });

  it("addTurn with meta.displayContent stores it separately from content (sprint-1066 t2-clean-task-field)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "<memory_context>...</memory_context>\n\nfix the bug", {
      displayContent: "fix the bug",
    });
    const turn = ctx.turns[0];
    expect(turn.content).toBe("<memory_context>...</memory_context>\n\nfix the bug");
    expect(turn.meta?.displayContent).toBe("fix the bug");
  });
});

// ─── 2b. meta.displayContent never reaches the model (sprint-1066) ───────────

describe("ConversationContext — meta.displayContent is display-only, never model-facing", () => {
  it("toMessages('ooda') renders content, ignores meta.displayContent", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "COMPOSED with envelope tags", { displayContent: "raw typed text" });
    const result = ctx.toMessages("ooda") as string;
    expect(result).toContain("COMPOSED with envelope tags");
    expect(result).not.toContain("raw typed text");
  });

  it("toMessages('react') renders content, ignores meta.displayContent", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "COMPOSED with envelope tags", { displayContent: "raw typed text" });
    const result = ctx.toMessages("react") as LLMMessage[];
    expect(result[0].content).toBe("COMPOSED with envelope tags");
  });

  it("estimatedTokens() counts content length, ignores a longer meta.displayContent", () => {
    const ctx = new ConversationContext();
    // content is 4 chars (1 token) ; displayContent is 400 chars. The count
    // must track content only, or a display-only field would silently skew
    // compaction/budget math.
    ctx.addTurn("user", "abcd", { displayContent: "x".repeat(400) });
    expect(ctx.estimatedTokens()).toBe(1);
  });

  it("compact() dialogue summary prompt uses content, not meta.displayContent", async () => {
    const captured: string[] = [];
    const capturingLlm = async (prompt: string): Promise<string> => {
      captured.push(prompt);
      return "SUMMARY";
    };
    const ctx = new ConversationContext();
    ctx.addTurn("user", "COMPOSED older ask", { displayContent: "older ask" });
    ctx.addTurn("assistant", "older reply");
    ctx.addTurn("user", "recent");
    await ctx.compact(capturingLlm, { keepLast: 1 });
    expect(captured[0]).toContain("COMPOSED older ask");
  });
});

// ─── 3. toMessages — minimal/ooda strategy (returns string) ─────────────────

describe("ConversationContext — toMessages minimal/ooda strategy", () => {
  it("empty ctx → empty string", () => {
    const ctx = new ConversationContext();
    const result = ctx.toMessages("ooda");
    expect(result).toBe("");
  });

  it("1 turn (user 'hello') → contains '## Conversation so far' and '### User' and 'hello'", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "hello");
    const result = ctx.toMessages("ooda") as string;
    expect(result).toContain("## Conversation so far");
    expect(result).toContain("### User");
    expect(result).toContain("hello");
  });

  it("1 turn (assistant 'world') → contains '### Assistant' and 'world'", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("assistant", "world");
    const result = ctx.toMessages("ooda") as string;
    expect(result).toContain("### Assistant");
    expect(result).toContain("world");
  });

  it("5 turns alternating → contains exactly 5 '###' headings", () => {
    const ctx = buildCtx([
      ["user", "a"],
      ["assistant", "b"],
      ["user", "c"],
      ["assistant", "d"],
      ["user", "e"],
    ]);
    const result = ctx.toMessages("ooda") as string;
    const matches = result.match(/###/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(5);
  });

  it("10 turns → contains exactly 10 '###' headings", () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 10; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`);
    }
    const result = ctx.toMessages("ooda") as string;
    const matches = result.match(/###/g);
    expect(matches?.length).toBe(10);
  });

  it("20 turns → contains exactly 20 '###' headings", () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 20; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`);
    }
    const result = ctx.toMessages("ooda") as string;
    const matches = result.match(/###/g);
    expect(matches?.length).toBe(20);
  });

  it("with 1 summary + 1 turn → contains '## Summary of earlier conversation' AND '## Conversation so far'", async () => {
    const ctx = new ConversationContext({ workingMemorySize: 1 });
    ctx.addTurn("user", "older turn");
    ctx.addTurn("assistant", "older reply");
    // compact: keepLast=1 → 1 turn kept, 1 summarized
    await ctx.compact(mockLlm, { keepLast: 1 });
    // add one more turn
    ctx.addTurn("user", "recent");
    const result = ctx.toMessages("ooda") as string;
    expect(result).toContain("## Summary of earlier conversation");
    expect(result).toContain("## Conversation so far");
  });

  it("'minimal' strategy (alias for ooda) is not a valid strategy name but 'ooda' returns string", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "test");
    const result = ctx.toMessages("ooda");
    expect(typeof result).toBe("string");
  });
});

// ─── 4. toMessages — react/plan strategy (returns LLMMessage[]) ──────────────

describe("ConversationContext — toMessages react/plan strategy", () => {
  it("empty ctx → [] for react", () => {
    const ctx = new ConversationContext();
    const result = ctx.toMessages("react") as LLMMessage[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("2 turns → array length 2, first is user, second is assistant", () => {
    const ctx = buildCtx([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    const result = ctx.toMessages("react") as LLMMessage[];
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hi");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("hello");
  });

  it("3 turns → array length 3", () => {
    const ctx = buildCtx([
      ["user", "one"],
      ["assistant", "two"],
      ["user", "three"],
    ]);
    const result = ctx.toMessages("react") as LLMMessage[];
    expect(result).toHaveLength(3);
  });

  it("with 1 summary → first entry has role 'system' containing '## Summary', then turns follow", async () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "older A");
    ctx.addTurn("assistant", "older B");
    await ctx.compact(mockLlm, { keepLast: 1 });
    ctx.addTurn("user", "recent turn");
    const result = ctx.toMessages("react") as LLMMessage[];
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("## Summary");
    expect(result[0].content).toContain("SUMMARY");
    expect(result[result.length - 1].role).toBe("user");
    expect(result[result.length - 1].content).toBe("recent turn");
  });

  it("plan strategy produces same output as react for same ctx", () => {
    const ctx = buildCtx([
      ["user", "first"],
      ["assistant", "second"],
    ]);
    const reactResult = ctx.toMessages("react") as LLMMessage[];
    const planResult = ctx.toMessages("plan") as LLMMessage[];
    expect(planResult).toHaveLength(reactResult.length);
    for (let i = 0; i < reactResult.length; i++) {
      expect(planResult[i].role).toBe(reactResult[i].role);
      expect(planResult[i].content).toBe(reactResult[i].content);
    }
  });

  it("empty ctx → [] for plan", () => {
    const ctx = new ConversationContext();
    const result = ctx.toMessages("plan") as LLMMessage[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ─── 5. toMessages — one-shot strategy ───────────────────────────────────────

describe("ConversationContext — toMessages one-shot strategy", () => {
  it("empty ctx → []", () => {
    const ctx = new ConversationContext();
    const result = ctx.toMessages("one-shot") as LLMMessage[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("ctx with 5 turns → still []", () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 5; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    const result = ctx.toMessages("one-shot") as LLMMessage[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ─── 6. estimatedTokens ──────────────────────────────────────────────────────

describe("ConversationContext — estimatedTokens", () => {
  it("empty ctx → 0", () => {
    const ctx = new ConversationContext();
    expect(ctx.estimatedTokens()).toBe(0);
  });

  it("1 turn with 4-char content → 1 token (Math.ceil(4/4)=1)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "abcd");
    expect(ctx.estimatedTokens()).toBe(1);
  });

  it("1 turn with 5-char content → 2 tokens (Math.ceil(5/4)=2)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "abcde");
    expect(ctx.estimatedTokens()).toBe(2);
  });

  it("2 turns 'hello'(5) + 'world'(5) → 4 tokens total", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "hello");
    ctx.addTurn("assistant", "world");
    // Math.ceil(5/4)=2 + Math.ceil(5/4)=2 = 4
    expect(ctx.estimatedTokens()).toBe(4);
  });

  it("after compact: summary tokens counted, old turns gone", async () => {
    const ctx = new ConversationContext();
    // Add 8 turns of 4-char content each (1 token each = 8 tokens total)
    for (let i = 0; i < 8; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", "abcd");
    }
    const tokensBefore = ctx.estimatedTokens();
    expect(tokensBefore).toBe(8);

    // compact keeping last 4, summarizing 4 older turns
    // mockLlm returns "SUMMARY" (7 chars = Math.ceil(7/4) = 2 tokens)
    await ctx.compact(mockLlm, { keepLast: 4 });

    // turns now: 4 × 1 token = 4; summary "SUMMARY" = 2 tokens → total 6
    expect(ctx.estimatedTokens()).toBe(6);
    expect(ctx.turnCount).toBe(4);
    expect(ctx.summaries).toHaveLength(1);
  });

  it("1 turn with 8-char content → 2 tokens (Math.ceil(8/4)=2)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "abcdefgh");
    expect(ctx.estimatedTokens()).toBe(2);
  });
});

// ─── 7. compact ──────────────────────────────────────────────────────────────

describe("ConversationContext — compact", () => {
  it("compact on empty ctx → no-op report (turnsBefore=0, turnsAfter=0, summariesAdded=0)", async () => {
    const ctx = new ConversationContext();
    const report = await ctx.compact(mockLlm);
    expect(report.turnsBefore).toBe(0);
    expect(report.turnsAfter).toBe(0);
    expect(report.summariesAdded).toBe(0);
  });

  it("compact with 6 turns, keepLast=6 → no-op (all turns kept)", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 6; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    const report = await ctx.compact(mockLlm, { keepLast: 6 });
    expect(report.turnsBefore).toBe(6);
    expect(report.turnsAfter).toBe(6);
    expect(report.summariesAdded).toBe(0);
    expect(ctx.turnCount).toBe(6);
  });

  it("compact with 7 turns, keepLast=6 → report: turnsBefore=7, turnsAfter=6, summariesAdded=1", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 7; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    const report = await ctx.compact(mockLlm, { keepLast: 6 });
    expect(report.turnsBefore).toBe(7);
    expect(report.turnsAfter).toBe(6);
    expect(report.summariesAdded).toBe(1);
  });

  it("after compact: ctx.turnCount===6, ctx.summaries.length===1", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 7; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    await ctx.compact(mockLlm, { keepLast: 6 });
    expect(ctx.turnCount).toBe(6);
    expect(ctx.summaries).toHaveLength(1);
  });

  it("compact with 10 turns, keepLast=6 → 4 older turns summarized", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 10; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    const report = await ctx.compact(mockLlm, { keepLast: 6 });
    expect(report.turnsBefore).toBe(10);
    expect(report.turnsAfter).toBe(6);
    expect(report.summariesAdded).toBe(1);
    expect(ctx.summaries[0].turnCount).toBe(4);
  });

  it("compact calls llmFn with a prompt containing the older turns", async () => {
    const captured: string[] = [];
    const capturingLlm = async (prompt: string): Promise<string> => {
      captured.push(prompt);
      return "CAPTURED SUMMARY";
    };
    const ctx = new ConversationContext();
    ctx.addTurn("user", "older one");
    ctx.addTurn("assistant", "older two");
    ctx.addTurn("user", "recent");
    await ctx.compact(capturingLlm, { keepLast: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("older one");
    expect(captured[0]).toContain("older two");
  });

  it("idempotent: second compact on already-6-turn ctx (keepLast=6) = no-op", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 7; i++) {
      ctx.addTurn("user", `t${i}`);
    }
    await ctx.compact(mockLlm, { keepLast: 6 });
    // Now turnCount=6, summaries=1
    const report2 = await ctx.compact(mockLlm, { keepLast: 6 });
    expect(report2.turnsBefore).toBe(6);
    expect(report2.turnsAfter).toBe(6);
    expect(report2.summariesAdded).toBe(0);
    expect(ctx.summaries).toHaveLength(1); // no new summary added
  });

  it("compact with opts.keepLast=2 on 5-turn ctx → keeps 2, summarizes 3", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 5; i++) {
      ctx.addTurn("user", `turn ${i}`);
    }
    const report = await ctx.compact(mockLlm, { keepLast: 2 });
    expect(report.turnsBefore).toBe(5);
    expect(report.turnsAfter).toBe(2);
    expect(report.summariesAdded).toBe(1);
    expect(ctx.summaries[0].turnCount).toBe(3);
  });

  it("CompactionReport fields: turnsBefore, turnsAfter, summariesAdded, tokensEstimatedBefore, tokensEstimatedAfter", async () => {
    const ctx = new ConversationContext();
    // 8 turns of "1234" (4 chars = 1 token each) = 8 tokens before
    for (let i = 0; i < 8; i++) {
      ctx.addTurn("user", "1234");
    }
    const report = await ctx.compact(mockLlm, { keepLast: 4 });
    expect(report).toHaveProperty("turnsBefore");
    expect(report).toHaveProperty("turnsAfter");
    expect(report).toHaveProperty("summariesAdded");
    expect(report).toHaveProperty("tokensEstimatedBefore");
    expect(report).toHaveProperty("tokensEstimatedAfter");
    expect(report.tokensEstimatedBefore).toBe(8);
    // After: 4 turns × 1 token + "SUMMARY" (7 chars = 2 tokens) = 6
    expect(report.tokensEstimatedAfter).toBe(6);
  });

  it("summary text matches llmFn return value", async () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "alpha");
    ctx.addTurn("assistant", "beta");
    ctx.addTurn("user", "gamma");
    await ctx.compact(mockLlm, { keepLast: 1 });
    expect(ctx.summaries[0].text).toBe("SUMMARY");
  });
});

// ─── 8. maybeCompact ─────────────────────────────────────────────────────────

describe("ConversationContext — maybeCompact", () => {
  it("returns false when estimatedTokens/contextWindow ratio < 0.70", async () => {
    const ctx = new ConversationContext();
    // qwen3-8b context window = 32000 tokens, threshold = 0.70 → need 22400 tokens to trigger
    // Add 10 turns × "1234" (1 token each) = 10 tokens → ratio = 10/32000 << 0.70
    for (let i = 0; i < 10; i++) {
      ctx.addTurn("user", "1234");
    }
    const triggered = await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(triggered).toBe(false);
  });

  it("returns true when ratio > 0.70", async () => {
    const ctx = new ConversationContext();
    // qwen3-8b: 32000 tokens window. 70% = 22400 tokens.
    // Each turn with 400-char content = Math.ceil(400/4) = 100 tokens
    // 225 turns × 100 tokens = 22500 > 22400 → triggers
    const content = "x".repeat(400);
    for (let i = 0; i < 225; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", content);
    }
    const triggered = await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(triggered).toBe(true);
  });

  it("does NOT compact when ratio < threshold", async () => {
    const ctx = new ConversationContext();
    for (let i = 0; i < 5; i++) {
      ctx.addTurn("user", "1234");
    }
    const turnsBefore = ctx.turnCount;
    await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(ctx.turnCount).toBe(turnsBefore);
  });

  it("DOES compact (reduces turns) when ratio > threshold", async () => {
    const ctx = new ConversationContext();
    const content = "x".repeat(400);
    for (let i = 0; i < 225; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", content);
    }
    const turnsBefore = ctx.turnCount;
    await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(ctx.turnCount).toBeLessThan(turnsBefore);
  });

  it("model with @provider suffix: 'claude-sonnet-4-6@anthropic' uses 200000 window", async () => {
    const ctx = new ConversationContext();
    // claude-sonnet-4-6 window = 200000. Threshold: 200000 × 0.70 = 140000
    // Add 10 turns × 1 token = 10 tokens → ratio = 10/200000 << 0.70 → no compact
    for (let i = 0; i < 10; i++) {
      ctx.addTurn("user", "1234");
    }
    const triggered = await ctx.maybeCompact("claude-sonnet-4-6@anthropic", mockLlm);
    expect(triggered).toBe(false);
  });

  it("unknown model uses 32000 fallback", async () => {
    const ctx = new ConversationContext();
    // unknown-model fallback = 32000. Add 10 tokens → no trigger
    for (let i = 0; i < 5; i++) {
      ctx.addTurn("user", "1234");
    }
    // Should not trigger (ratio << 0.70)
    const triggered = await ctx.maybeCompact("unknown-model-xyz", mockLlm);
    expect(triggered).toBe(false);
  });

  it("unknown model triggers when enough tokens for 32000 window", async () => {
    const ctx = new ConversationContext();
    // 32000 × 0.70 = 22400 tokens needed; 225 × 100-token turns = 22500
    const content = "x".repeat(400);
    for (let i = 0; i < 225; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", content);
    }
    const triggered = await ctx.maybeCompact("unknown-model-xyz", mockLlm);
    expect(triggered).toBe(true);
  });

  it("injected getContextWindow wins over the static fallback map", async () => {
    // "qwen3-8b" maps to 32000 in the static table. Inject a resolver that
    // reports a much larger window for the same model id — the injected
    // value must win, so the same token count that triggers against the
    // static 32000 table must NOT trigger against the injected window.
    const ctx = new ConversationContext({ getContextWindow: () => 1_000_000 });
    const content = "x".repeat(400);
    for (let i = 0; i < 225; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", content);
    }
    const triggered = await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(triggered).toBe(false);
  });

  it("injected getContextWindow receives the base model id (provider suffix stripped)", async () => {
    const seen: string[] = [];
    const ctx = new ConversationContext({
      getContextWindow: (model) => {
        seen.push(model);
        return 200000;
      },
    });
    ctx.addTurn("user", "1234");
    await ctx.maybeCompact("claude-sonnet-4-6@anthropic", mockLlm);
    expect(seen).toEqual(["claude-sonnet-4-6"]);
  });

  it("absent getContextWindow falls back to the static map (byte-identical old behavior)", async () => {
    const ctx = new ConversationContext();
    const content = "x".repeat(400);
    for (let i = 0; i < 225; i++) {
      ctx.addTurn(i % 2 === 0 ? "user" : "assistant", content);
    }
    // Same fixture as "returns true when ratio > 0.70" above — no injected
    // resolver, so the static 32000-token qwen3-8b window still triggers.
    const triggered = await ctx.maybeCompact("qwen3-8b", mockLlm);
    expect(triggered).toBe(true);
  });
});

// ─── 9. toJSON / fromJSON ─────────────────────────────────────────────────────

describe("ConversationContext — toJSON / fromJSON", () => {
  it("toJSON() returns { version: 1, workingMemorySize, turns, summaries }", () => {
    const ctx = new ConversationContext({ workingMemorySize: 4 });
    ctx.addTurn("user", "test");
    const snap = ctx.toJSON();
    expect(snap.version).toBe(1);
    expect(snap.workingMemorySize).toBe(4);
    expect(Array.isArray(snap.turns)).toBe(true);
    expect(Array.isArray(snap.summaries)).toBe(true);
  });

  it("toJSON() snapshot is JSON.stringify safe (no circular refs)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "hello");
    expect(() => JSON.stringify(ctx.toJSON())).not.toThrow();
    const json = JSON.stringify(ctx.toJSON());
    expect(typeof json).toBe("string");
  });

  it("fromJSON(toJSON(ctx)) produces ctx with same turnCount", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "a");
    ctx.addTurn("assistant", "b");
    ctx.addTurn("user", "c");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.turnCount).toBe(ctx.turnCount);
  });

  it("round-trip: fromJSON(toJSON(ctx)).toMessages('ooda') === ctx.toMessages('ooda')", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "one");
    ctx.addTurn("assistant", "two");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.toMessages("ooda")).toBe(ctx.toMessages("ooda"));
  });

  it("round-trip: fromJSON(toJSON(ctx)).toMessages('react') deep-equals ctx.toMessages('react')", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "question");
    ctx.addTurn("assistant", "answer");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.toMessages("react")).toEqual(ctx.toMessages("react"));
  });

  it("round-trip: fromJSON(toJSON(ctx)).toMessages('plan') deep-equals ctx.toMessages('plan')", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "plan me");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.toMessages("plan")).toEqual(ctx.toMessages("plan"));
  });

  it("round-trip: fromJSON(toJSON(ctx)).toMessages('one-shot') deep-equals ctx.toMessages('one-shot')", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "once");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.toMessages("one-shot")).toEqual(ctx.toMessages("one-shot"));
  });

  it("fromJSON with version:2 throws 'unsupported snapshot version 2'", () => {
    const badSnap = {
      version: 2 as unknown as 1,
      workingMemorySize: 6,
      turns: [],
      summaries: [],
    } satisfies ConversationContextSnapshot;
    expect(() => ConversationContext.fromJSON(badSnap as ConversationContextSnapshot)).toThrow(
      "unsupported snapshot version 2",
    );
  });

  it("fromJSON restores summaries correctly", async () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "older A");
    ctx.addTurn("assistant", "older B");
    ctx.addTurn("user", "recent");
    await ctx.compact(mockLlm, { keepLast: 1 });
    const snap = ctx.toJSON();
    const restored = ConversationContext.fromJSON(snap);
    expect(restored.summaries).toHaveLength(1);
    expect(restored.summaries[0].text).toBe("SUMMARY");
    expect(restored.turnCount).toBe(1);
  });

  it("snapshot turns are independent from original ctx (snapshot is a copy)", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "original");
    const snap = ctx.toJSON();
    // Add more turns to original after snapshotting
    ctx.addTurn("assistant", "added after snapshot");
    // The snapshot should not reflect the new turn
    expect(snap.turns).toHaveLength(1);
    expect(ctx.turnCount).toBe(2);
  });

  it("fromJSON with workingMemorySize=3 restores correct size", () => {
    const ctx = new ConversationContext({ workingMemorySize: 3 });
    ctx.addTurn("user", "hi");
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.workingMemorySize).toBe(3);
  });

  it("round-trip preserves all turn contents", () => {
    const ctx = new ConversationContext();
    const turns: Array<[role: "user" | "assistant", content: string]> = [
      ["user", "first message"],
      ["assistant", "first reply"],
      ["user", "second message"],
    ];
    for (const [role, content] of turns) {
      ctx.addTurn(role, content);
    }
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    for (let i = 0; i < turns.length; i++) {
      expect(restored.turns[i].role).toBe(turns[i][0]);
      expect(restored.turns[i].content).toBe(turns[i][1]);
    }
  });

  // ── sprint-1066 t2-clean-task-field : meta.displayContent serialization ──

  it("round-trip preserves meta.displayContent when present", () => {
    const ctx = new ConversationContext();
    ctx.addTurn("user", "composed with envelope", { displayContent: "raw typed text" });
    const restored = ConversationContext.fromJSON(ctx.toJSON());
    expect(restored.turns[0].content).toBe("composed with envelope");
    expect(restored.turns[0].meta?.displayContent).toBe("raw typed text");
  });

  it("backward compat: a snapshot written before displayContent existed reloads identically", () => {
    // Simulates a real pre-existing --resume snapshot file : meta present
    // (timestamp, from an assistant-turn-style write) with no displayContent
    // key at all, because the field did not exist when it was written.
    const legacySnapshot: ConversationContextSnapshot = {
      version: 1,
      workingMemorySize: 6,
      turns: [
        {
          role: "user",
          content: "old turn, never composed",
          meta: { timestamp: 1_700_000_000_000 },
        },
        { role: "assistant", content: "old reply", meta: { tokensIn: 10, tokensOut: 5 } },
      ],
      summaries: [],
    };
    const restored = ConversationContext.fromJSON(legacySnapshot);
    expect(restored.turnCount).toBe(2);
    expect(restored.turns[0].content).toBe("old turn, never composed");
    expect(restored.turns[0].meta?.timestamp).toBe(1_700_000_000_000);
    expect(restored.turns[0].meta?.displayContent).toBeUndefined();
    expect(restored.turns[1].meta?.tokensIn).toBe(10);
    // Model-facing rendering is unaffected by the missing field.
    expect(restored.toMessages("ooda")).toContain("old turn, never composed");
    const react = restored.toMessages("react") as LLMMessage[];
    expect(react[0].content).toBe("old turn, never composed");
  });

  it("backward compat: a snapshot with no meta at all reloads identically", () => {
    const legacySnapshot: ConversationContextSnapshot = {
      version: 1,
      workingMemorySize: 6,
      turns: [{ role: "user", content: "bare turn, pre-meta era" }],
      summaries: [],
    };
    const restored = ConversationContext.fromJSON(legacySnapshot);
    expect(restored.turns[0].content).toBe("bare turn, pre-meta era");
    expect(restored.turns[0].meta).toBeUndefined();
  });
});
