/**
 * loop-run-start-origin.test.ts ; sprint-1066 t2-remote-origin-label.
 *
 * A remote-queued turn (the `message` control verb -> `remoteUserTurnQueue`
 * -> `processTurn`) and a local (typed) turn reach the SAME `processTurn`
 * call, so RUN_STARTED is byte-identical between the two ; a remote observer
 * cannot tell which is which. `run()` now accepts an optional
 * `{ origin: "local" | "remote" }` so a host that knows where the turn came
 * from can label it. Absent `origin` (the default, local turn) omits the
 * field from RUN_STARTED entirely ; behavior is byte-identical to before.
 */

import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  type ProviderRouter,
  type ProviderRouterResponse,
  createBudgetState,
} from "../src/index.js";
import { __resetEventSeq, createRemoteControlHub } from "../src/remote/index.js";
import { RunStartPayloadSchema } from "../src/remote/events.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function completingProvider(): ProviderRouter {
  return {
    async complete(): Promise<ProviderRouterResponse> {
      return {
        provider: "mock",
        content: "final answer",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function newLoop(hub: ReturnType<typeof createRemoteControlHub>): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider: completingProvider(),
    tools: new ToolRegistryImpl(),
    budget: createBudgetState({ maxSteps: 0 }),
    disableLoopDetection: true,
    eventSink: hub,
  });
}

function runStartedData(
  hub: ReturnType<typeof createRemoteControlHub>,
): { task?: string; origin?: "local" | "remote" } | undefined {
  const started = hub.backlog().find((e) => e.type === "RUN_STARTED");
  return started && started.type === "RUN_STARTED" ? started.data : undefined;
}

describe("RunStartPayloadSchema ; origin field", () => {
  it("accepts a payload with origin: remote", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
      origin: "remote",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a payload with no origin field at all (absent = local implicit)", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    expect(result.success && "origin" in result.data).toBe(false);
  });

  it("rejects an origin value outside the local|remote enum", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
      origin: "pod",
    });
    expect(result.success).toBe(false);
  });
});

describe("AgentLoop.run ; RUN_STARTED.origin", () => {
  it("sets RUN_STARTED.origin to 'remote' when opts.origin is 'remote'", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("ship the release", { origin: "remote" });

    expect(runStartedData(hub)?.origin).toBe("remote");
  });

  it("omits RUN_STARTED.origin when opts is undefined (byte-identical legacy behavior)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello");

    const data = runStartedData(hub);
    expect(data).toBeDefined();
    expect(data && "origin" in data).toBe(false);
  });

  it("omits RUN_STARTED.origin when opts.origin is undefined (e.g. only displayTask set)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello", { displayTask: "hello" });

    const data = runStartedData(hub);
    expect(data && "origin" in data).toBe(false);
  });

  it("sets RUN_STARTED.origin to 'local' when opts.origin is explicitly 'local'", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello", { origin: "local" });

    expect(runStartedData(hub)?.origin).toBe("local");
  });

  it("combines origin and displayTask independently", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const composed = "<memory_context>...</memory_context>\n\nship the release";
    await newLoop(hub).run(composed, { displayTask: "ship the release", origin: "remote" });

    const data = runStartedData(hub);
    expect(data?.task).toBe("ship the release");
    expect(data?.origin).toBe("remote");
  });
});
