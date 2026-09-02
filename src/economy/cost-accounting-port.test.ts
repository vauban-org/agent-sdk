/**
 * cost-accounting-port.test.ts ; W0 (ADR-ECO-101) unit contract.
 *
 * Proves the decorator aggregates cost / tokens / cache / latency per OODA cycle
 * (correlationId) and per worker (agentId), accounts errors without losing the
 * response contract, and stays deterministic under an injected clock.
 */

import { describe, expect, it } from "vitest";
import type { ChatResponse, ChatUsage, LLMProviderPort } from "../ports/llm-provider.js";
import { createCostAccountingPort } from "./cost-accounting-port.js";

/** Clock that advances by a fixed step on every read (2 reads per complete()). */
function steppingClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

function fakeProvider(
  opts: {
    usage?: Partial<ChatUsage>;
    finishReason?: ChatResponse["finishReason"];
    throwError?: boolean;
  } = {},
): LLMProviderPort {
  return {
    async complete(): Promise<ChatResponse> {
      if (opts.throwError) throw new Error("boom");
      return {
        content: "ok",
        model: "fake",
        finishReason: opts.finishReason ?? "stop",
        usage: { inputTokens: 0, outputTokens: 0, ...opts.usage },
      };
    },
  };
}

describe("createCostAccountingPort", () => {
  it("aggregates tokens, cost, cache and latency in the same (cycle, worker) cell", async () => {
    const port = createCostAccountingPort(
      fakeProvider({
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.01,
          cacheReadTokens: 50,
        },
      }),
      { now: steppingClock(1000) },
    );
    const meta = { metadata: { correlationId: "c1", agentId: "observer" } };
    await port.complete({ messages: [], ...meta });
    await port.complete({ messages: [], ...meta });

    const s = port.snapshot();
    expect(s.totals.callCount).toBe(2);
    expect(s.totals.inputTokens).toBe(200);
    expect(s.totals.outputTokens).toBe(40);
    expect(s.totals.cacheReadTokens).toBe(100);
    expect(s.totals.costUsd).toBeCloseTo(0.02, 10);
    expect(s.totals.latencyMs).toBe(2000); // 2 calls × (2000-1000)
    expect(s.byCycle).toHaveLength(1);
    expect(s.byCycle[0].correlationId).toBe("c1");
    expect(s.byWorker).toHaveLength(1);
    expect(s.byWorker[0].agentId).toBe("observer");
  });

  it("groups distinct cycles and distinct workers separately", async () => {
    const port = createCostAccountingPort(
      fakeProvider({ usage: { inputTokens: 10, outputTokens: 1 } }),
      { now: steppingClock(1) },
    );
    await port.complete({
      messages: [],
      metadata: { correlationId: "c1", agentId: "observer" },
    });
    await port.complete({
      messages: [],
      metadata: { correlationId: "c2", agentId: "analyst" },
    });

    const s = port.snapshot();
    expect(s.byCycle.map((r) => r.correlationId).sort()).toEqual(["c1", "c2"]);
    expect(s.byWorker.map((r) => r.agentId).sort()).toEqual(["analyst", "observer"]);
    expect(s.totals.callCount).toBe(2);
  });

  it("computes cacheHitRatio = cacheRead / (input + cacheRead)", async () => {
    const port = createCostAccountingPort(
      fakeProvider({ usage: { inputTokens: 100, cacheReadTokens: 50 } }),
      { now: steppingClock(1) },
    );
    await port.complete({ messages: [] });
    expect(port.snapshot().cacheHitRatio).toBeCloseTo(50 / 150, 10);
  });

  it("returns cacheHitRatio 0 when no input tokens were seen", () => {
    const port = createCostAccountingPort(fakeProvider(), {
      now: steppingClock(1),
    });
    expect(port.snapshot().cacheHitRatio).toBe(0);
  });

  it("counts a finishReason:error response as an error but still returns it", async () => {
    const port = createCostAccountingPort(fakeProvider({ finishReason: "error" }), {
      now: steppingClock(1),
    });
    const resp = await port.complete({ messages: [] });
    expect(resp.finishReason).toBe("error");
    expect(port.snapshot().totals.errorCount).toBe(1);
  });

  it("counts a thrown error, measures its latency, and rethrows", async () => {
    const port = createCostAccountingPort(fakeProvider({ throwError: true }), {
      now: steppingClock(5),
    });
    await expect(port.complete({ messages: [] })).rejects.toThrow("boom");
    const s = port.snapshot();
    expect(s.totals.errorCount).toBe(1);
    expect(s.totals.callCount).toBe(1);
    expect(s.totals.latencyMs).toBe(5);
  });

  it("defaults correlationId and agentId to 'unknown' when metadata is absent", async () => {
    const port = createCostAccountingPort(fakeProvider(), {
      now: steppingClock(1),
    });
    await port.complete({ messages: [] });
    const s = port.snapshot();
    expect(s.byCycle[0].correlationId).toBe("unknown");
    expect(s.byWorker[0].agentId).toBe("unknown");
  });

  it("passes the underlying response through unchanged", async () => {
    const port = createCostAccountingPort(
      fakeProvider({ usage: { inputTokens: 7, outputTokens: 3 } }),
      { now: steppingClock(1) },
    );
    const resp = await port.complete({ messages: [] });
    expect(resp.content).toBe("ok");
    expect(resp.model).toBe("fake");
    expect(resp.usage.inputTokens).toBe(7);
  });

  it("reset() clears all accumulated telemetry", async () => {
    const port = createCostAccountingPort(fakeProvider(), {
      now: steppingClock(1),
    });
    await port.complete({ messages: [] });
    expect(port.snapshot().totals.callCount).toBe(1);
    port.reset();
    expect(port.snapshot().totals.callCount).toBe(0);
    expect(port.snapshot().byCycle).toHaveLength(0);
  });
});
