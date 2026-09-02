/**
 * loop-run-start-display-task.test.ts ; sprint-1066 t2-clean-task-field.
 *
 * A host (preste's cmd-chat) composes the actual LLM prompt from the raw user
 * message plus injected envelope blocks (<memory_context>, <session_focus>,
 * journal recap, tool-reliability priors). That composed string is correct as
 * the LLM input, but wrong as the RUN_STARTED.task shown to a remote observer
 * ; it leaked the envelope's internal tags into the transcript. `run()` now
 * accepts an optional `{ displayTask }` so the caller can separate "what the
 * model reads" from "what a human should see the run started with". Absent
 * `displayTask`, behavior is byte-identical to before (task = userMessage).
 */

import { describe, expect, it } from "vitest";
import {
  AgentLoop,
  type ProviderRouter,
  type ProviderRouterResponse,
  createBudgetState,
} from "../src/index.js";
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

function runStartedTask(hub: ReturnType<typeof createRemoteControlHub>): string | undefined {
  const started = hub.backlog().find((e) => e.type === "RUN_STARTED");
  return started && started.type === "RUN_STARTED" ? started.data.task : undefined;
}

describe("AgentLoop.run ; RUN_STARTED.task vs the composed LLM prompt", () => {
  it("uses displayTask for RUN_STARTED.task when provided, independent of the composed userMessage", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const composed =
      "<memory_context>\nprior decisions...\n</memory_context>\n\n<session_focus>fix the bug</session_focus>\n\nfix the login bug";
    const result = await newLoop(hub).run(composed, { displayTask: "fix the login bug" });

    expect(result.stopReason).toBe("complete");
    expect(runStartedTask(hub)).toBe("fix the login bug");
    // The composed string, tags included, never leaks into the displayed task.
    expect(runStartedTask(hub)).not.toContain("<memory_context>");
  });

  it("falls back to userMessage when displayTask is omitted (byte-identical legacy behavior)", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello");

    expect(runStartedTask(hub)).toBe("hello");
  });

  it("falls back to userMessage when opts is an empty object", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    await newLoop(hub).run("hello", {});

    expect(runStartedTask(hub)).toBe("hello");
  });

  it("still applies the 32k-char guard, sliced from displayTask when provided", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const longDisplay = "d".repeat(40_000);
    await newLoop(hub).run("short composed prompt", { displayTask: longDisplay });

    const task = runStartedTask(hub);
    expect(task?.length).toBe(32_000);
    expect(task).toBe(longDisplay.slice(0, 32_000));
  });

  it("applies the 32k-char guard to the fallback userMessage exactly as before", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const longMessage = "m".repeat(40_000);
    await newLoop(hub).run(longMessage);

    const task = runStartedTask(hub);
    expect(task?.length).toBe(32_000);
    expect(task).toBe(longMessage.slice(0, 32_000));
  });
});
