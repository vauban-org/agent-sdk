/**
 * tests/ooda-handoff.test.ts
 *
 * Sprint-563: B2 — Multi-agent handoff() + asAgentTool() + handoffChain anti-cycle.
 */

import { describe, expect, it } from "vitest";
import {
  HandoffCycleError,
  asAgentTool,
  handoff,
  handoffToEvent,
} from "../src/orchestration/ooda/handoff.js";
import type { AgentDescriptor, AgentHandoffClient } from "../src/orchestration/ooda/handoff.js";

const fakeCtx = { agentId: "agent-a", runId: "r1", cycleIndex: 0 } as any;

class FakeClient implements AgentHandoffClient {
  calls: Array<{ agentId: string; input: any }> = [];

  async execute(
    agentId: string,
    input: { messages: Array<{ role: string; content: string }>; handoffChain: string[] },
  ): Promise<{ runId: string }> {
    this.calls.push({ agentId, input });
    return { runId: `child-${agentId}-${this.calls.length}` };
  }
}

describe("handoff", () => {
  it("calls client.execute with messages and handoffChain", async () => {
    const client = new FakeClient();

    const result = await handoff(
      {
        targetAgentId: "agent-b",
        messages: [{ role: "user", content: "hello" }],
        handoffChain: [],
        ctx: fakeCtx,
      },
      client,
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.agentId).toBe("agent-b");
    expect(client.calls[0]!.input.messages).toHaveLength(1);
    expect(result.childRunId).toBe("child-agent-b-1");
    expect(result.accepted).toBe(true);
  });

  it("throws HandoffCycleError when agent is already in chain", async () => {
    const client = new FakeClient();

    await expect(
      handoff(
        {
          targetAgentId: "agent-a",
          messages: [{ role: "user", content: "loop" }],
          handoffChain: ["agent-a", "agent-b"],
          ctx: fakeCtx,
        },
        client,
      ),
    ).rejects.toThrow(HandoffCycleError);
  });

  it("extends handoffChain in result", async () => {
    const client = new FakeClient();

    const result = await handoff(
      {
        targetAgentId: "agent-c",
        messages: [],
        handoffChain: ["agent-a"],
        ctx: fakeCtx,
      },
      client,
    );

    expect(result.nextChain).toEqual(["agent-a", "agent-c"]);
  });
});

describe("handoffToEvent", () => {
  it("emits CycleEventV011 handoff_initiated", () => {
    const event = handoffToEvent("agent-b", "child-1", ["agent-a"], "run-1", 0);

    expect(event.type).toBe("handoff_initiated");
    expect(event.targetAgentId).toBe("agent-b");
    expect(event.childRunId).toBe("child-1");
    expect(event.handoffChain).toEqual(["agent-a"]);
  });
});

describe("asAgentTool", () => {
  it("creates an MCP-compatible tool from descriptor", async () => {
    const client = new FakeClient();
    const descriptor: AgentDescriptor = {
      agentId: "market-radar",
      name: "Market Radar",
      description: "Monitors market conditions",
      inputSchema: {},
    };

    const tool = await asAgentTool(descriptor, client);

    expect(tool.name).toBe("agent_market_radar");
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toEqual(["messages"]);

    const result = await tool.handler({
      messages: [{ role: "user", content: "what's the price?" }],
    });

    expect(result.runId).toContain("market-radar");
    expect(client.calls[0]!.input.handoffChain).toEqual([]);
  });

  it("defaults handoffChain to empty array", async () => {
    const client = new FakeClient();
    const tool = await asAgentTool(
      {
        agentId: "test-agent",
        name: "Test",
        description: "Test agent",
        inputSchema: {},
      },
      client,
    );

    await tool.handler({ messages: [] });
    expect(client.calls[0]!.input.handoffChain).toEqual([]);
  });
});
