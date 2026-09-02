import { describe, expect, it } from "vitest";
import { type LogMessage, createBudgetState } from "../src/index.js";
import { createCompactor } from "../src/run-memory/compactor.js";

function bigLog(): LogMessage[] {
  const log: LogMessage[] = [
    { role: "system", content: "you are an agent" },
    { role: "user", content: "do the big task" },
  ];
  for (let i = 0; i < 20; i++) {
    log.push({ role: "assistant", content: `step ${i}: calling tool ${"x".repeat(200)}` });
    log.push({ role: "tool", content: `result ${i} ${"y".repeat(200)}`, toolName: "run_bash" });
  }
  return log;
}

/** Budget sized so bigLog() (~2160 est. tokens) sits at ~0.80: above the 0.7 threshold, below the 0.9 emergency. */
function smallBudget() {
  return createBudgetState({ contextWindow: { maxTokens: 2700, currentTokens: 0 } });
}

describe("createCompactor", () => {
  it("does nothing below threshold", async () => {
    const c = createCompactor();
    const log: LogMessage[] = [{ role: "user", content: "hi" }];
    const out = await c.maybeCompact(log, smallBudget(), async () => "s");
    expect(out.compacted).toBe(false);
    expect(out.mode).toBe("none");
  });

  it("compacts above threshold: keeps system+first user+last K, emits index with stepIndex", async () => {
    const log = bigLog();
    const indices = new WeakMap<LogMessage, number>();
    log.forEach((m, i) => indices.set(m, i));
    const c = createCompactor({ keepLast: 4, indexFor: (m) => indices.get(m) });
    const out = await c.maybeCompact(log, smallBudget(), async () => "SUMMARY-BODY");
    expect(out.compacted).toBe(true);
    expect(out.mode).toBe("llm");
    expect(out.log[0]?.role).toBe("system");
    expect(out.log[1]?.content).toBe("do the big task");
    const summary = out.log[2];
    expect(summary?.role).toBe("system");
    expect(summary?.content).toContain("SUMMARY-BODY");
    expect(summary?.content).toContain("recall(");
    expect(summary?.content).toMatch(/- step \d+ \[tool:run_bash\]/);
    expect(out.log.slice(3)).toHaveLength(4);
  });

  it("falls back to deterministic index when the summarizer throws", async () => {
    const c = createCompactor({ keepLast: 4 });
    const out = await c.maybeCompact(bigLog(), smallBudget(), async () => {
      throw new Error("llm down");
    });
    expect(out.compacted).toBe(true);
    expect(out.mode).toBe("deterministic");
    expect(out.log[2]?.content).toContain("summarizer unavailable");
  });

  it("emergency ratio (>=0.9) keeps only 2 recent messages", async () => {
    const budget = createBudgetState({ contextWindow: { maxTokens: 1000, currentTokens: 0 } });
    const c = createCompactor({ keepLast: 6 });
    const out = await c.maybeCompact(bigLog(), budget, async () => "S");
    expect(out.compacted).toBe(true);
    expect(out.log.slice(3)).toHaveLength(2);
  });

  it("is idempotent enough: second pass on compacted log does not re-compact below threshold", async () => {
    const budget = smallBudget();
    const c = createCompactor({ keepLast: 4 });
    const first = await c.maybeCompact(bigLog(), budget, async () => "S");
    const second = await c.maybeCompact(first.log, budget, async () => "S");
    expect(second.compacted).toBe(false);
  });

  it("positional indexFor overrides config.indexFor", async () => {
    const log = bigLog();
    const c = createCompactor({ keepLast: 4, indexFor: () => 999 });
    const out = await c.maybeCompact(
      log,
      smallBudget(),
      async () => "S",
      (m) => log.indexOf(m),
    );
    expect(out.log[2]?.content).not.toContain("step 999");
  });
});
