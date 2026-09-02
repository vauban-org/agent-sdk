/**
 * minimal-loop honestApprovalStops (f1, sprint-1009, ADR-ECO-076).
 *
 * A headless child's HITL denial must NOT collapse onto the overloaded
 * `user_cancelled` (the lie that read as "the user cancelled" in a parent
 * transcript). With `honestApprovalStops` on, an explicit deny stops with
 * `approval_denied`, a fail-closed timeout with `approval_timeout`, and the
 * "no approver at all" case with `approval_denied`. Off (the default) : the
 * loop is byte-identical, so cmd-chat / cmd-agent and their pinned consumers
 * are untouched.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Approval, ApprovalChannel, ApprovalRequest } from "../src/hitl/approval-channel.js";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/** Provider: call the dangerous `run_bash` once, then finalize once its result
 * is in the log. Models a child that needs to run a shell command. */
function makeBashThenFinalizeProvider(): ProviderRouter {
  return {
    async complete(req) {
      const ranTool = req.messages.some((m) => m.role === "tool");
      if (ranTool) {
        return {
          provider: "mock",
          model: "mock",
          content: "FINAL: command ran, here is the answer.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        model: "mock",
        content: "I need to run a command",
        toolCalls: [{ id: "c1", name: "run_bash", args: { command: "ls -la /secret" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

/** Provider that never calls a tool (byte-identical baseline path). */
function makeNoToolProvider(): ProviderRouter {
  return {
    async complete() {
      return {
        provider: "mock",
        model: "mock",
        content: "done, no tool needed",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "run_bash",
    description: "run a shell command",
    parameters: z.object({ command: z.string() }).strict(),
    dangerous: true,
    execute: async (args) => ({
      ok: true,
      stdout: `ran: ${(args as { command: string }).command}`,
    }),
  });
  return reg;
}

/** A one-shot approval channel returning a fixed verdict on the first poll. */
function makeChannel(verdict: Approval | "never"): ApprovalChannel {
  const sent: ApprovalRequest[] = [];
  let cancelled = false;
  return {
    async send(req) {
      sent.push(req);
      return "req-1";
    },
    async poll() {
      return verdict === "never" ? null : verdict;
    },
    async cancel() {
      cancelled = true;
    },
    // Expose captured state for assertions (extra props are harmless).
    _sent: sent,
    get _cancelled() {
      return cancelled;
    },
  } as ApprovalChannel & { _sent: ApprovalRequest[]; _cancelled: boolean };
}

function build(opts: {
  provider: ProviderRouter;
  channel?: ApprovalChannel;
  honest: boolean;
}): AgentLoop {
  return new AgentLoop({
    agentId: "CHILD_AGENT",
    agentVersion: "test",
    systemPrompt: "sys",
    provider: opts.provider,
    tools: makeRegistry(),
    budget: createBudgetState({ maxSteps: 4 }),
    disableLoopDetection: true,
    // Short deadline so the timeout path resolves fast.
    approvalTimeoutMs: 50,
    approvalPollIntervalMs: 5,
    ...(opts.channel ? { approvalChannel: opts.channel } : {}),
    ...(opts.honest ? { honestApprovalStops: true } : {}),
  });
}

const approveVerdict: Approval = { approved: true, by: "parent", at: new Date().toISOString() };
const denyVerdict: Approval = { approved: false, by: "human", at: new Date().toISOString() };
const timeoutVerdict: Approval = {
  approved: false,
  by: "timeout-policy",
  at: new Date().toISOString(),
  timedOut: true,
};

describe("minimal-loop honestApprovalStops", () => {
  it("APPROVE: a granted dangerous tool runs and the child completes with real output", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      channel: makeChannel(approveVerdict),
      honest: true,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("complete");
    expect(result.finalMessage).toMatch(/FINAL: command ran/);
  });

  it("DENY (honest on): stops with approval_denied, never user_cancelled", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      channel: makeChannel(denyVerdict),
      honest: true,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("approval_denied");
  });

  it("TIMEOUT (honest on): a fail-closed timeout stops with approval_timeout", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      channel: makeChannel(timeoutVerdict),
      honest: true,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("approval_timeout");
  });

  it("TIMEOUT via our own deadline (poll never resolves) stops with approval_timeout", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      channel: makeChannel("never"),
      honest: true,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("approval_timeout");
  });

  it("NO CHANNEL (honest on): a dangerous tool fails closed as approval_denied, not user_cancelled", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      honest: true,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("approval_denied");
  });

  // ── Mutation guards: force the old behavior back, watch the honest reason go ──
  it("BYTE-IDENTICAL (honest OFF): the same deny still reports user_cancelled", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      channel: makeChannel(denyVerdict),
      honest: false,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("user_cancelled");
  });

  it("BYTE-IDENTICAL (honest OFF): no channel still reports user_cancelled", async () => {
    const result = await build({
      provider: makeBashThenFinalizeProvider(),
      honest: false,
    }).run("list the secret dir");
    expect(result.stopReason).toBe("user_cancelled");
  });

  it("BYTE-IDENTICAL: no dangerous tool called ends in complete regardless of the flag", async () => {
    const honest = await build({ provider: makeNoToolProvider(), honest: true }).run("hi");
    const legacy = await build({ provider: makeNoToolProvider(), honest: false }).run("hi");
    expect(honest.stopReason).toBe("complete");
    expect(legacy.stopReason).toBe("complete");
    expect(honest.finalMessage).toBe(legacy.finalMessage);
  });
});
