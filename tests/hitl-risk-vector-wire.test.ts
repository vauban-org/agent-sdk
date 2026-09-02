/**
 * Tests for the RiskVector -> HITL wiring (sprint-1067, T3 risk-vector-wire).
 *
 * `tools/types.ts` already carries a rich `RiskVector` + `riskScore()` that no
 * caller ever read. This wires it, additively, into the ApprovalRequest sent
 * by `AgentLoop.awaitApproval()`, the `HitlRequestPayloadSchema` event
 * payload, and `RemoteApprovalChannel`'s emitted `hitl.request` event ; a tool
 * with no `risk` produces byte-identical output at every hop.
 *
 * Covers:
 *   packages/agent-sdk/src/hitl/approval-channel.ts — toApprovalRisk()
 *   packages/agent-sdk/src/loop/minimal-loop.ts — channel.send() risk join
 *   packages/agent-sdk/src/remote/events.ts — HitlRequestPayloadSchema.risk
 *   packages/agent-sdk/src/remote/approval.ts — RemoteApprovalChannel forwarding
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type ApprovalChannel,
  type ApprovalRequest,
  riskScore,
  toApprovalRisk,
  type RiskVector,
} from "../src/index.js";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { HitlRequestPayloadSchema } from "../src/remote/events.js";
import {
  createRemoteApprovalChannel,
  createRemoteControlHub,
  type SessionEvent,
} from "../src/remote/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

const SAMPLE_VECTOR: RiskVector = {
  reversibility: 0.9,
  blastRadius: 0.6,
  dataSensitivity: 0.4,
  externalSideEffect: 0.2,
  confidence: 0.8,
};

// ─── toApprovalRisk() — hitl/approval-channel.ts ──────────────────────────

describe("toApprovalRisk", () => {
  it("derives score via the existing riskScore() and mirrors the 4 display axes", () => {
    const risk = toApprovalRisk(SAMPLE_VECTOR);
    expect(risk.score).toBeCloseTo(riskScore(SAMPLE_VECTOR), 10);
    expect(risk.reversibility).toBe(SAMPLE_VECTOR.reversibility);
    expect(risk.blastRadius).toBe(SAMPLE_VECTOR.blastRadius);
    expect(risk.dataSensitivity).toBe(SAMPLE_VECTOR.dataSensitivity);
    expect(risk.externalSideEffect).toBe(SAMPLE_VECTOR.externalSideEffect);
    // confidence feeds the score but is not a separate display axis.
    expect(Object.keys(risk).sort()).toEqual(
      ["blastRadius", "dataSensitivity", "externalSideEffect", "reversibility", "score"].sort(),
    );
  });
});

// ─── HitlRequestPayloadSchema — remote/events.ts ──────────────────────────

describe("HitlRequestPayloadSchema", () => {
  const base = { requestId: "r1", action: "run_bash", context: "{}" };

  it("validates without risk (byte-identical, absent field)", () => {
    expect(HitlRequestPayloadSchema.safeParse(base).success).toBe(true);
  });

  it("validates with a well-formed risk sub-object", () => {
    const risk = toApprovalRisk(SAMPLE_VECTOR);
    expect(HitlRequestPayloadSchema.safeParse({ ...base, risk }).success).toBe(true);
  });

  it("rejects a risk sub-object missing a required axis (strict shape)", () => {
    const risk = toApprovalRisk(SAMPLE_VECTOR);
    const { blastRadius, ...incomplete } = risk;
    expect(HitlRequestPayloadSchema.safeParse({ ...base, risk: incomplete }).success).toBe(false);
  });

  it("rejects a risk sub-object with an unknown extra field (.strict())", () => {
    const risk = toApprovalRisk(SAMPLE_VECTOR);
    expect(
      HitlRequestPayloadSchema.safeParse({
        ...base,
        risk: { ...risk, extra: "nope" },
      }).success,
    ).toBe(false);
  });

  it("rejects a score outside [0, 1]", () => {
    const risk = { ...toApprovalRisk(SAMPLE_VECTOR), score: 1.5 };
    expect(HitlRequestPayloadSchema.safeParse({ ...base, risk }).success).toBe(false);
  });
});

// ─── RemoteApprovalChannel — remote/approval.ts ───────────────────────────

describe("RemoteApprovalChannel risk forwarding", () => {
  it("forwards ApprovalRequest.risk onto the emitted hitl.request event", async () => {
    const hub = createRemoteControlHub();
    const events: SessionEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const chan = createRemoteApprovalChannel({ sink: hub });
    const risk = toApprovalRisk(SAMPLE_VECTOR);

    await chan.send({
      agentId: "tester",
      action: "run_bash",
      context: "{}",
      timeoutMs: 1_000,
      risk,
    });

    const requested = events.find((e) => e.type === "CUSTOM_HITL_REQUEST");
    expect(requested).toBeDefined();
    expect((requested?.data as { risk?: unknown }).risk).toEqual(risk);
    chan.dispose();
  });

  it("omits risk on the emitted event when the request carries none", async () => {
    const hub = createRemoteControlHub();
    const events: SessionEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const chan = createRemoteApprovalChannel({ sink: hub });

    await chan.send({ agentId: "tester", action: "run_bash", context: "{}", timeoutMs: 1_000 });

    const requested = events.find((e) => e.type === "CUSTOM_HITL_REQUEST");
    expect((requested?.data as { risk?: unknown }).risk).toBeUndefined();
    chan.dispose();
  });
});

// ─── AgentLoop.awaitApproval() — loop/minimal-loop.ts ─────────────────────

function makeBashThenFinalizeProvider(): ProviderRouter {
  return {
    async complete(req) {
      const ranTool = req.messages.some((m) => m.role === "tool");
      if (ranTool) {
        return {
          provider: "mock",
          model: "mock",
          content: "FINAL: done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        model: "mock",
        content: "running",
        toolCalls: [{ id: "c1", name: "run_bash", args: { command: "ls" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeRegistry(risk?: RiskVector): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "run_bash",
    description: "run a shell command",
    parameters: z.object({ command: z.string() }).strict(),
    dangerous: true,
    ...(risk ? { risk } : {}),
    execute: async (args) => ({
      ok: true,
      stdout: `ran: ${(args as { command: string }).command}`,
    }),
  });
  return reg;
}

function makeCapturingChannel(): ApprovalChannel & { sent: ApprovalRequest[] } {
  const sent: ApprovalRequest[] = [];
  return {
    sent,
    async send(req) {
      sent.push(req);
      return "req-1";
    },
    async poll() {
      return { approved: true, by: "human", at: new Date().toISOString() };
    },
    async cancel() {},
  };
}

describe("AgentLoop.awaitApproval risk join", () => {
  it("joins risk on channel.send when the dispatched tool declares a RiskVector", async () => {
    const channel = makeCapturingChannel();
    await new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeBashThenFinalizeProvider(),
      tools: makeRegistry(SAMPLE_VECTOR),
      budget: createBudgetState({ maxSteps: 4 }),
      disableLoopDetection: true,
      approvalChannel: channel,
      approvalTimeoutMs: 1_000,
      approvalPollIntervalMs: 5,
    }).run("list files");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].risk).toEqual(toApprovalRisk(SAMPLE_VECTOR));
  });

  it("byte-identical: risk is absent on channel.send when the tool declares no RiskVector", async () => {
    const channel = makeCapturingChannel();
    await new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider: makeBashThenFinalizeProvider(),
      tools: makeRegistry(), // no RiskVector — legacy `dangerous: true` only
      budget: createBudgetState({ maxSteps: 4 }),
      disableLoopDetection: true,
      approvalChannel: channel,
      approvalTimeoutMs: 1_000,
      approvalPollIntervalMs: 5,
    }).run("list files");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].risk).toBeUndefined();
    expect("risk" in channel.sent[0]).toBe(false);
  });
});
