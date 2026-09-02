/**
 * loop-run-start-steerid.test.ts ; sprint-1067 t3-steerid-correlation.
 *
 * The optimistic echo a controller (phone/web) shows the instant it sends a
 * `message` or `steer` claim needs an EXACT correlator for the signed event
 * that later echoes it back ; matching by text alone (the pre-existing
 * behavior, see `pwa/src/lib/optimistic-echo.ts`) is a heuristic that a
 * duplicate turn or an interleaved local turn can defeat. `RunStartPayload`
 * and `InstructionInjectedPayload` now carry an optional `steerId`, mirrored
 * from the originating control envelope's own `steerId` (the SAME field
 * `ControlAckPayload.steerId` already correlates an ack to). Absent `steerId`
 * (the default : a local turn, or a claim with no id) omits the field
 * entirely ; behavior is byte-identical to before this option existed. This
 * file mirrors `loop-run-start-origin.test.ts`'s structure exactly (the same
 * additive-opts-threading shape, PR #345).
 */

import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  type ProviderRouter,
  type ProviderRouterResponse,
  createBudgetState,
} from "../src/index.js";
import { InstructionInjectedPayloadSchema, RunStartPayloadSchema } from "../src/remote/events.js";
import { __resetEventSeq, createRemoteControlHub } from "../src/remote/index.js";
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
): { task?: string; steerId?: string } | undefined {
  const started = hub.backlog().find((e) => e.type === "RUN_STARTED");
  return started && started.type === "RUN_STARTED" ? started.data : undefined;
}

describe("RunStartPayloadSchema ; steerId field", () => {
  it("accepts a payload with a steerId", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
      steerId: "steer-abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a payload with no steerId field at all (absent = no claim id)", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    expect(result.success && "steerId" in result.data).toBe(false);
  });

  it("rejects a non-string steerId", () => {
    const result = RunStartPayloadSchema.safeParse({
      runId: "r1",
      agentId: "a1",
      startedAt: "2026-01-01T00:00:00.000Z",
      steerId: 42,
    });
    expect(result.success).toBe(false);
  });
});

describe("InstructionInjectedPayloadSchema ; steerId field", () => {
  it("accepts a payload with a steerId", () => {
    const result = InstructionInjectedPayloadSchema.safeParse({
      text: "focus the tests",
      source: "controller:inst_abc",
      whisper: false,
      steerId: "steer-xyz",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a payload with no steerId field at all", () => {
    const result = InstructionInjectedPayloadSchema.safeParse({
      text: "focus the tests",
      source: "controller:inst_abc",
      whisper: false,
    });
    expect(result.success).toBe(true);
    expect(result.success && "steerId" in result.data).toBe(false);
  });
});

describe("AgentLoop.run ; RUN_STARTED.steerId", () => {
  it("sets RUN_STARTED.steerId when opts.steerId is supplied", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("ship the release", { origin: "remote", steerId: "steer-1" });

    expect(runStartedData(hub)?.steerId).toBe("steer-1");
  });

  it("omits RUN_STARTED.steerId when opts is undefined (byte-identical legacy behavior)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello");

    const data = runStartedData(hub);
    expect(data).toBeDefined();
    expect(data && "steerId" in data).toBe(false);
  });

  it("omits RUN_STARTED.steerId when opts.steerId is undefined (e.g. only origin set)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello", { origin: "remote" });

    const data = runStartedData(hub);
    expect(data && "steerId" in data).toBe(false);
  });

  it("combines steerId, origin, and displayTask independently", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const composed = "<memory_context>...</memory_context>\n\nship the release";
    await newLoop(hub).run(composed, {
      displayTask: "ship the release",
      origin: "remote",
      steerId: "steer-2",
    });

    const data = runStartedData(hub);
    expect(data?.task).toBe("ship the release");
    expect(data?.steerId).toBe("steer-2");
  });
});

describe("AgentLoop.run ; CUSTOM_INSTRUCTION_INJECTED.steerId (mid-run drain)", () => {
  it("threads the queued Instruction's steerId onto the re-emitted event", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    let calls = 0;
    const provider: ProviderRouter = {
      async complete(): Promise<ProviderRouterResponse> {
        calls += 1;
        if (calls === 1) {
          // A `steer` claim arrives mid-run, carrying its own steerId.
          hub.inbox.enqueue("also check the logs", "controller:inst_abc", false, "steer-mid-1");
          return {
            provider: "mock",
            content: "step 1",
            toolCalls: [{ id: "c1", name: "noop", args: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        }
        return {
          provider: "mock",
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: new ToolRegistryImpl(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      eventSink: hub,
      instructionInbox: hub.inbox,
    });
    await loop.run("initial task");

    const injected = hub.backlog().find((e) => e.type === "CUSTOM_INSTRUCTION_INJECTED");
    expect(injected).toBeDefined();
    expect(injected?.type === "CUSTOM_INSTRUCTION_INJECTED" && injected.data.steerId).toBe(
      "steer-mid-1",
    );
  });

  it("omits steerId on the re-emitted event when the queued Instruction carried none", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    let calls = 0;
    const provider: ProviderRouter = {
      async complete(): Promise<ProviderRouterResponse> {
        calls += 1;
        if (calls === 1) {
          hub.inbox.enqueue("also check the logs", "remote:phone");
          return {
            provider: "mock",
            content: "step 1",
            toolCalls: [{ id: "c1", name: "noop", args: {} }],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        }
        return {
          provider: "mock",
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: new ToolRegistryImpl(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      eventSink: hub,
      instructionInbox: hub.inbox,
    });
    await loop.run("initial task");

    const injected = hub.backlog().find((e) => e.type === "CUSTOM_INSTRUCTION_INJECTED");
    expect(injected).toBeDefined();
    expect(injected?.type === "CUSTOM_INSTRUCTION_INJECTED" && "steerId" in injected.data).toBe(
      false,
    );
  });
});
