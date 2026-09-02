/**
 * minimal-loop `onApprovalResolved` — un seul point de tir, apres
 * `awaitApproval`, notifiant l'ISSUE definitive de l'attente d'approbation
 * humaine (approved / denied / timeout / gate_revoked). Le collecteur de
 * recu d'execution de preste (packages/cli) en devient le premier
 * consommateur : l'ActionGate seul ne peut pas voir CETTE information (il
 * decide AVANT l'attente, jamais apres) — cf. `PolicyObligation.HUMAN_APPROVAL`,
 * command-center/packages/cli/src/receipt/policy-obligation.ts.
 *
 * Meme style que minimal-loop-approval-timeout-continue.test.ts et
 * minimal-loop-gate-revoked.test.ts (canal muet/decidant, run_bash dangereux,
 * provider qui committe deux fois puis conclut).
 *
 * @see ../src/loop/minimal-loop.ts (AgentLoopConfig.onApprovalResolved)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalChannel } from "../src/hitl/approval-channel.js";
import {
  type ActionGate,
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function makeRegistry(executed: string[]): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "run_bash",
    description: "run a shell command",
    parameters: z.object({ command: z.string() }).strict(),
    dangerous: true,
    execute: async (args) => {
      const cmd = (args as { command: string }).command;
      executed.push(cmd);
      return { ok: true, stdout: `ran: ${cmd}` };
    },
  });
  return reg;
}

function makeCommitTwiceProvider(): ProviderRouter {
  let toolTurns = 0;
  return {
    async complete() {
      if (toolTurns >= 2) {
        return {
          provider: "mock",
          model: "mock",
          content: "FINAL: conclu.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      toolTurns += 1;
      return {
        provider: "mock",
        model: "mock",
        content: "Je committe.",
        toolCalls: [
          { id: `c${toolTurns}`, name: "run_bash", args: { command: "git commit -m x" } },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

/** UN seul appel, puis conclut sur le resultat de l'outil. Contrairement a
 * makeCommitTwiceProvider (qui rejoue deux fois, utile quand l'outil ne
 * tourne JAMAIS avec un canal refusant/muet), un canal APPROUVANT execute
 * reellement l'outil des le premier appel : rejouer deux fois donnerait deux
 * executions reelles, pas le scenario voulu. */
function makeCommitOnceProvider(): ProviderRouter {
  let called = false;
  return {
    async complete() {
      if (called) {
        return {
          provider: "mock",
          model: "mock",
          content: "FINAL: conclu.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      called = true;
      return {
        provider: "mock",
        model: "mock",
        content: "Je committe.",
        toolCalls: [{ id: "c1", name: "run_bash", args: { command: "git commit -m x" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeSilentChannel(): ApprovalChannel {
  return {
    async send() {
      return "req-1";
    },
    async poll() {
      return null;
    },
    async cancel() {
      /* no-op */
    },
  };
}

function makeDecidingChannel(approved: boolean): ApprovalChannel {
  return {
    async send() {
      return "req-1";
    },
    async poll() {
      return { approved, by: "founder", at: new Date().toISOString() };
    },
    async cancel() {
      /* no-op */
    },
  };
}

function makeFlippingGate(allowFirstN: number): ActionGate {
  let calls = 0;
  return {
    verify() {
      calls += 1;
      if (calls <= allowFirstN) return { allowed: true, reason: "posture couvre encore" };
      return {
        allowed: false,
        reason: 'run_bash — la posture de séance ("plan") refuse toute mutation',
        kind: "posture_denied",
      };
    },
  };
}

type ResolvedEvent = { toolName: string; outcome: string; reason?: string };

describe("minimal-loop — onApprovalResolved", () => {
  it("approved : un seul evenement, outcome=approved, aucun 'reason'", async () => {
    const executed: string[] = [];
    const events: ResolvedEvent[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitOnceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeDecidingChannel(true),
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      onApprovalResolved: (e) => events.push(e),
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual(["git commit -m x"]); // approuve : l'outil a REELLEMENT tourne
    expect(events).toEqual([{ toolName: "run_bash", outcome: "approved" }]);
  });

  it("denied : un seul evenement, outcome=denied, le tour s'arrete", async () => {
    const executed: string[] = [];
    const events: ResolvedEvent[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeDecidingChannel(false),
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      onApprovalResolved: (e) => events.push(e),
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("approval_denied");
    expect(executed).toEqual([]);
    expect(events).toEqual([{ toolName: "run_bash", outcome: "denied" }]);
  });

  it("timeout : un seul evenement, outcome=timeout", async () => {
    const executed: string[] = [];
    const events: ResolvedEvent[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeSilentChannel(),
      honestApprovalStops: true,
      approvalTimeoutMs: 30,
      approvalPollIntervalMs: 5,
      onApprovalResolved: (e) => events.push(e),
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("approval_timeout");
    expect(executed).toEqual([]);
    expect(events).toEqual([{ toolName: "run_bash", outcome: "timeout" }]);
  });

  it("gate_revoked : un seul evenement, outcome=gate_revoked, avec reason", async () => {
    const executed: string[] = [];
    const events: ResolvedEvent[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeSilentChannel(),
      actionGate: makeFlippingGate(1),
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      onApprovalResolved: (e) => events.push(e),
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.toolName).toBe("run_bash");
    expect(events[0]?.outcome).toBe("gate_revoked");
    expect(events[0]?.reason).toBeDefined();
  });

  it("un callback qui THROW n'altere jamais la decision (best-effort)", async () => {
    const executed: string[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitOnceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeDecidingChannel(true),
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      onApprovalResolved: () => {
        throw new Error("callback casse");
      },
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual(["git commit -m x"]); // le throw n'a rien change
  });

  it("absent (defaut) : byte-identique, aucun changement de comportement", async () => {
    const executed: string[] = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitOnceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeDecidingChannel(true),
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      // pas de onApprovalResolved
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual(["git commit -m x"]);
  });
});
