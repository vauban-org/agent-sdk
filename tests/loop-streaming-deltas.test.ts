/**
 * loop-streaming-deltas.test.ts ; C2 streaming (session-dans-la-poche,
 * docs/superpowers/specs/2026-07-23-session-dans-la-poche-design.md C2).
 *
 * The loop, when an eventSink is wired, streams a step's assistant text as
 * EPHEMERAL `TEXT_MESSAGE_CONTENT` deltas just before the durable
 * `TEXT_MESSAGE_END`. The deltas reach live subscribers but never the ring
 * backlog, they carry a sentinel seq (they stay off the durable monotonic
 * sequence, keeping it gap-free), and with no sink the run is byte-identical.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type AgentLoopRunResult,
  type ProviderRouter,
  type ProviderRouterCompleteOptions,
  type ProviderRouterResponse,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { type SessionEvent, __resetEventSeq, createRemoteControlHub } from "../src/remote/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function registry(): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "noop",
    description: "no-op",
    parameters: z.object({ n: z.number() }).strict(),
    execute: async (a) => ({ ok: true, echo: (a as { n: number }).n }),
  });
  return reg;
}

/** A provider that replies with a fixed script of responses, one per step. */
function scriptedProvider(script: ProviderRouterResponse[]): ProviderRouter {
  let i = 0;
  return {
    async complete() {
      const r = script[Math.min(i, script.length - 1)];
      i += 1;
      return r;
    },
  };
}

function resp(
  content: string,
  toolCalls: ProviderRouterResponse["toolCalls"] = [],
): ProviderRouterResponse {
  return {
    provider: "mock",
    content,
    toolCalls,
    usage: { inputTokens: 5, outputTokens: 3 },
    latencyMs: 0,
  };
}

function newLoop(
  provider: ProviderRouter,
  eventSink?: ReturnType<typeof createRemoteControlHub>,
): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider,
    tools: registry(),
    budget: createBudgetState({ maxSteps: 0 }),
    disableLoopDetection: true,
    ...(eventSink ? { eventSink } : {}),
  });
}

describe("AgentLoop C2 streaming ; ephemeral coalesced deltas", () => {
  it("streams TEXT_MESSAGE_CONTENT deltas to live subscribers that reconstruct the message", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));

    // A block larger than the 1200-char flush size -> several coalesced deltas.
    const answer = "z".repeat(2500);
    const loop = newLoop(scriptedProvider([resp(answer)]), hub);
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");

    const deltas = live.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    // 2500 chars / 1200 -> 1200 + 1200 + 100 = three deltas.
    expect(deltas.length).toBe(3);
    // Their concatenation reconstructs the message byte-for-byte.
    const rebuilt = deltas
      .map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.data.text : ""))
      .join("");
    expect(rebuilt).toBe(answer);

    // The durable record (TEXT_MESSAGE_END) still carries the full content.
    const end = live.find((e) => e.type === "TEXT_MESSAGE_END");
    expect(end && end.type === "TEXT_MESSAGE_END" ? end.data.content : null).toBe(answer);
  });

  it("keeps deltas out of the ring backlog (ephemeral) while TEXT_MESSAGE_END is retained", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const loop = newLoop(scriptedProvider([resp("the final answer")]), hub);
    await loop.run("hello");

    const backlogTypes = hub.backlog().map((e) => e.type);
    expect(backlogTypes).not.toContain("TEXT_MESSAGE_CONTENT");
    expect(backlogTypes).toContain("TEXT_MESSAGE_END");
    expect(backlogTypes).toContain("RUN_STARTED");
    expect(backlogTypes).toContain("RUN_FINISHED");
  });

  it("emits every delta before the durable TEXT_MESSAGE_END on the live wire", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));
    const loop = newLoop(scriptedProvider([resp("x".repeat(1500))]), hub);
    await loop.run("hello");

    const endIdx = live.findIndex((e) => e.type === "TEXT_MESSAGE_END");
    const lastDeltaIdx = live.map((e) => e.type).lastIndexOf("TEXT_MESSAGE_CONTENT");
    expect(endIdx).toBeGreaterThanOrEqual(0);
    expect(lastDeltaIdx).toBeGreaterThanOrEqual(0);
    expect(lastDeltaIdx).toBeLessThan(endIdx);
  });

  it("deltas carry the sentinel seq 0 and leave the durable seq stream gap-free", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));
    const loop = newLoop(scriptedProvider([resp("y".repeat(3000))]), hub);
    await loop.run("hello");

    // Every delta carries the ephemeral sentinel seq.
    for (const e of live.filter((e) => e.type === "TEXT_MESSAGE_CONTENT")) {
      expect(e.seq).toBe(0);
    }
    // The durable ring seqs are contiguous (no gap punched by the deltas).
    const seqs = hub.backlog().map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }
  });

  it("streams reasoning-content deltas on the content+tool-call step too", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));
    const loop = newLoop(
      scriptedProvider([
        resp("let me compute", [{ name: "noop", args: { n: 1 } }]),
        resp("the answer"),
      ]),
      hub,
    );
    await loop.run("hello");

    const deltaTexts = live
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.data.text : ""));
    // The reasoning content that preceded the tool call streamed as a delta...
    expect(deltaTexts).toContain("let me compute");
    // ...and so did the final answer.
    expect(deltaTexts).toContain("the answer");
  });

  it("is byte-identical when no sink is wired (result matches a sinked run)", async () => {
    __resetEventSeq();
    const script = (): ProviderRouterResponse[] => [
      resp("reason", [{ name: "noop", args: { n: 2 } }]),
      resp("final message"),
    ];

    const hub = createRemoteControlHub();
    const withSink = await newLoop(scriptedProvider(script()), hub).run("hello");
    const withoutSink = await newLoop(scriptedProvider(script())).run("hello");

    const shape = (r: AgentLoopRunResult) => ({
      finalMessage: r.finalMessage,
      stopReason: r.stopReason,
      stepCount: r.budgetFinal.stepCount,
    });
    expect(shape(withoutSink)).toEqual(shape(withSink));
    expect(withoutSink.finalMessage).toBe("final message");
  });
});

/**
 * A provider that calls `opts.onDelta` live, as its own transport would
 * (sprint-1065 t1-stream-deltas). `chunks` fire in order ; `advanceMsBefore`
 * lets a test move the fake clock forward BEFORE a given chunk lands, so the
 * coalescer's interval branch sees real elapsed time between pushes — the
 * exact seam this test file proves is no longer dormant.
 */
function liveStreamingProvider(
  script: Array<{
    chunks: Array<{ text: string; advanceMsBefore?: number }>;
    response: ProviderRouterResponse;
  }>,
): ProviderRouter {
  let i = 0;
  return {
    async complete(_req, opts?: ProviderRouterCompleteOptions) {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      for (const c of step.chunks) {
        if (c.advanceMsBefore) vi.advanceTimersByTime(c.advanceMsBefore);
        opts?.onDelta?.(c.text);
      }
      return step.response;
    },
  };
}

describe("AgentLoop C2 streaming ; live onDelta wiring (sprint-1065 t1-stream-deltas)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the interval branch fires mid-generation when the provider streams live deltas (previously dormant)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));

    // Two chunks separated by >= the 350ms default interval, both WAY under
    // the 1200-char size threshold ; any delta this produces can only come
    // from the interval branch, never the size branch.
    const provider = liveStreamingProvider([
      {
        chunks: [
          { text: "aaa" },
          { text: "bbb", advanceMsBefore: 400 },
          { text: "ccc", advanceMsBefore: 400 },
        ],
        response: resp("aaabbbccc"),
      },
    ]);
    const loop = newLoop(provider, hub);
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");

    const deltas = live.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    const texts = deltas.map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.data.text : ""));
    // Interval-driven: "aaa"+"bbb" flush together (400ms elapsed since the
    // coalescer's construction), then "ccc" flushes on its own (400ms since
    // the prior flush) — TWO deltas, not one final block.
    expect(texts).toEqual(["aaabbb", "ccc"]);
    expect(texts.join("")).toBe("aaabbbccc");

    // finalize() must not re-push the content: no delta beyond the two the
    // live stream already produced.
    expect(deltas.length).toBe(2);

    const end = live.find((e) => e.type === "TEXT_MESSAGE_END");
    expect(end && end.type === "TEXT_MESSAGE_END" ? end.data.content : null).toBe("aaabbbccc");
  });

  it("falls back to a single block push when the provider never calls onDelta (byte-identical to the pre-streaming path)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));

    // A provider that ignores `opts` entirely (today's contract) ; the loop
    // must fall back to pushing the whole content as one block, exactly as
    // it did before this wave.
    const loop = newLoop(
      {
        async complete() {
          return resp("a".repeat(50));
        },
      },
      hub,
    );
    await loop.run("hello");

    const deltas = live.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(deltas.length).toBe(1);
    expect(deltas[0].type === "TEXT_MESSAGE_CONTENT" ? deltas[0].data.text : null).toBe(
      "a".repeat(50),
    );
  });

  it("streamed deltas whose total covers the content are never re-emitted via the block fallback", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const live: SessionEvent[] = [];
    hub.subscribe((e) => live.push(e));

    // No clock advance at all -> the interval branch never fires and the
    // size branch never fires (well under 1200 chars) ; the coalescer just
    // buffers everything until `finalize()` flushes the remainder once.
    const provider = liveStreamingProvider([
      {
        chunks: [{ text: "hello " }, { text: "world" }],
        response: resp("hello world"),
      },
    ]);
    const loop = newLoop(provider, hub);
    await loop.run("hello");

    const deltas = live.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    const texts = deltas.map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.data.text : ""));
    // Exactly one flush (the trailing finalize), never a second copy of the
    // content from a fallback block-push.
    expect(texts).toEqual(["hello world"]);
  });
});
