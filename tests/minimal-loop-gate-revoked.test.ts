/**
 * minimal-loop `actionGate` re-check inside `awaitApproval` — ADR-ECO-135
 * §1.3 : une carte déjà ouverte au moment d'un changement de posture.
 *
 * Fail-closed dans un seul sens : si le gate ne couvre plus l'appel entre le
 * moment où la carte s'est ouverte et le moment où un humain y répond (ex.
 * la posture de séance bascule vers `plan` pendant l'attente), la carte se
 * ferme IMMÉDIATEMENT, sans consommer un timeout et sans jamais prétendre
 * qu'un humain a répondu. `gate_revoked` est une classe DISTINCTE de
 * `approval_denied`/`approval_timeout` — le refus vient du gate, pas d'un
 * geste humain ni d'un silence.
 *
 * Le sens inverse (le gate devient PLUS permissif pendant l'attente) ne
 * revoque rien : il n'y a jamais d'auto-approbation rétroactive d'une carte
 * déjà ouverte, la carte continue d'attendre son canal d'origine exactement
 * comme avant ce commit.
 *
 * Même style que minimal-loop-approval-timeout-continue.test.ts (canal
 * muet, `run_bash` dangereux, provider qui committe deux fois puis conclut).
 *
 * @see ../src/loop/minimal-loop.ts (awaitApproval, ApprovalWaitOutcome)
 * @see ../../cli/src/posture-gate.ts (le gate réel qui déclenche ce chemin en préste)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalChannel } from "../src/hitl/approval-channel.js";
import {
  type ActionGate,
  type ActionGateVerdict,
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/** Personne au bout du fil, jamais — la seule façon dont l'attente se
 * termine est le re-check du gate (ou le timeout naturel). */
function makeSilentChannel(): ApprovalChannel & {
  sentCount: () => number;
  cancelledCount: () => number;
} {
  let sent = 0;
  let cancelled = 0;
  return {
    async send() {
      sent += 1;
      return `req-${sent}`;
    },
    async poll() {
      return null;
    },
    async cancel() {
      cancelled += 1;
    },
    sentCount: () => sent,
    cancelledCount: () => cancelled,
  };
}

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
          content: "FINAL: je ne peux pas committer, je laisse la main.",
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

/** Un gate qui autorise les N premiers appels puis refuse ensuite — simule
 * une posture qui se durcit ENTRE l'ouverture de la carte et la réponse. */
function makeFlippingGate(
  allowFirstN: number,
  verdict: Partial<ActionGateVerdict> = {},
): ActionGate & { callCount: () => number } {
  let calls = 0;
  return {
    verify(): ActionGateVerdict {
      calls += 1;
      if (calls <= allowFirstN) return { allowed: true, reason: "posture couvre encore" };
      return {
        allowed: false,
        reason: 'run_bash — la posture de séance ("plan") refuse toute mutation',
        kind: "posture_denied",
        ...verdict,
      };
    },
    callCount: () => calls,
  };
}

describe("minimal-loop — awaitApproval revoque une carte ouverte quand le gate change d'avis", () => {
  it("gate durci pendant l'attente → carte annulée, kind posture_denied, le tour CONTINUE", async () => {
    const executed: string[] = [];
    const channel = makeSilentChannel();
    // 1er appel (le check pré-carte) laisse passer, les suivants (poll ticks
    // dans awaitApproval) refusent : simule un shift+tab survenu juste après
    // l'ouverture de la carte.
    const gate = makeFlippingGate(1);
    const denied: Array<{ toolName: string; kind?: string }> = [];
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: channel,
      actionGate: gate,
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
      onActionDenied: (e) => denied.push({ toolName: e.toolName, kind: e.kind }),
    });

    const res = await loop.run("committe le travail");

    // Le tour va jusqu'à sa conclusion ; il n'est PAS tué par la révocation.
    expect(res.stopReason).toBe("complete");
    expect(res.finalMessage).toContain("je laisse la main");
    // Fail-closed : l'outil dangereux n'a jamais tourné.
    expect(executed).toEqual([]);
    // La carte a bien été annulée côté canal (pas laissée en suspens).
    expect(channel.cancelledCount()).toBeGreaterThanOrEqual(1);
    // Le refus porte le kind du gate, pas un refus humain générique.
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(denied[0]).toEqual({ toolName: "run_bash", kind: "posture_denied" });
  });

  it("le message outil porte le préfixe ERROR: posture_denied:, jamais approval_denied", async () => {
    const executed: string[] = [];
    const seen: Array<{ role: string; content: string }> = [];
    const gate = makeFlippingGate(1);
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: {
        async complete(req) {
          for (const m of req.messages) {
            if (m.role === "tool") seen.push({ role: m.role, content: String(m.content) });
          }
          return {
            provider: "mock",
            model: "mock",
            content: req.messages.some((m) => m.role === "tool")
              ? "FINAL: compris."
              : "Je committe.",
            toolCalls: req.messages.some((m) => m.role === "tool")
              ? []
              : [{ id: "c1", name: "run_bash", args: { command: "git commit -m x" } }],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        },
      },
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeSilentChannel(),
      actionGate: gate,
      honestApprovalStops: true,
      approvalTimeoutMs: 200,
      approvalPollIntervalMs: 5,
    });

    await loop.run("committe le travail");

    expect(seen.some((m) => m.content.startsWith("ERROR: posture_denied:"))).toBe(true);
    expect(seen.some((m) => m.content.includes("approval_denied"))).toBe(false);
  });

  it("gate qui reste permissif pendant toute l'attente → jamais revoqué, le timeout naturel décide (aucune auto-approbation rétroactive)", async () => {
    const executed: string[] = [];
    const channel = makeSilentChannel();
    const gate: ActionGate = { verify: () => ({ allowed: true, reason: "toujours couvert" }) };
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: channel,
      actionGate: gate,
      honestApprovalStops: true,
      approvalTimeoutMs: 30,
      approvalPollIntervalMs: 5,
      continueOnApprovalTimeout: true,
    });

    const res = await loop.run("committe le travail");

    // Personne n'a annulé la carte via le gate (elle reste couverte) ; le
    // canal, lui, ne répond jamais : c'est le timeout naturel qui referme la
    // carte, jamais une révocation par gate.
    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual([]);
  });

  it("un gate qui THROW pendant le re-check ne révoque PAS une carte vivante (tolérance à l'échec transitoire)", async () => {
    const executed: string[] = [];
    const channel = makeSilentChannel();
    const gate: ActionGate = {
      verify() {
        throw new Error("gate transitoirement indisponible");
      },
    };
    const loop = new AgentLoop({
      agentId: "TEST",
      agentVersion: "1.0.0",
      systemPrompt: "test",
      provider: makeCommitTwiceProvider(),
      tools: makeRegistry(executed),
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: channel,
      actionGate: gate,
      honestApprovalStops: true,
      approvalTimeoutMs: 30,
      approvalPollIntervalMs: 5,
      continueOnApprovalTimeout: true,
    });

    const res = await loop.run("committe le travail");

    // Le throw est absorbé (comme le catch de l'action-gate pré-carte) ; le
    // canal muet referme par timeout naturel, pas par une fausse révocation.
    expect(res.stopReason).toBe("complete");
    expect(executed).toEqual([]);
  });
});
