/**
 * minimal-loop `continueOnApprovalTimeout` — une approbation que personne
 * n'honore ne tue plus le tour.
 *
 * Symptôme founder (journaux 2026-08-02, 6 sessions) : l'agent annonce « je
 * committe », émet le `run_bash` correspondant, la carte d'approbation part,
 * personne ne la voit, et 15 minutes plus tard le tour ENTIER meurt. Le travail
 * en cours est perdu et la session doit être relancée à la main. Trois fois
 * dans la même session (steps 682, 708, 759 du journal
 * `chat-30ecce87-…`) : ~915 s d'écart à chaque fois, la signature exacte de
 * `approvalTimeoutMs`.
 *
 * Le refus fail-closed est conservé (l'outil n'est JAMAIS exécuté sans
 * verdict) ; ce qui change est la portée de la conséquence : l'APPEL est
 * refusé, pas le TOUR. Le modèle reçoit le refus comme un résultat d'outil et
 * décide de la suite, exactement comme sur un `action_denied` (:960).
 *
 * Off (le défaut) : byte-identique.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalChannel } from "../src/hitl/approval-channel.js";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

/** Le canal du symptôme : la carte part, personne ne répond jamais. */
function makeSilentChannel(): ApprovalChannel & { sentCount: () => number } {
  let sent = 0;
  return {
    async send() {
      sent += 1;
      return `req-${sent}`;
    },
    async poll() {
      return null; // personne au bout du fil, jamais
    },
    async cancel() {
      /* no-op */
    },
    sentCount: () => sent,
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

/**
 * Le provider du symptôme : il tente `git commit` deux fois (le modèle
 * réessaie quand son premier appel revient en erreur), puis conclut.
 */
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

function makeLoop(
  opts: {
    channel: ApprovalChannel;
    registry: ToolRegistry;
    continueOnApprovalTimeout?: boolean;
    onApprovalTimeout?: (e: { toolName: string; timeoutMs: number }) => void;
  },
): AgentLoop {
  return new AgentLoop({
    agentId: "TEST",
    agentVersion: "1.0.0",
    systemPrompt: "test",
    provider: makeCommitTwiceProvider(),
    tools: opts.registry,
    budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
    approvalChannel: opts.channel,
    honestApprovalStops: true,
    approvalTimeoutMs: 60,
    approvalPollIntervalMs: 5,
    ...(opts.continueOnApprovalTimeout !== undefined
      ? { continueOnApprovalTimeout: opts.continueOnApprovalTimeout }
      : {}),
    ...(opts.onApprovalTimeout ? { onApprovalTimeout: opts.onApprovalTimeout } : {}),
  });
}

describe("minimal-loop — une approbation sans réponse ne tue plus le tour", () => {
  it("OFF (défaut) : le tour meurt sur le premier timeout (comportement d'avant)", async () => {
    const executed: string[] = [];
    const loop = makeLoop({ channel: makeSilentChannel(), registry: makeRegistry(executed) });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("approval_timeout");
    expect(executed).toEqual([]); // fail-closed : rien n'a tourné
  });

  it("ON : le tour continue, l'outil reste refusé, et le modèle conclut lui-même", async () => {
    const executed: string[] = [];
    const loop = makeLoop({
      channel: makeSilentChannel(),
      registry: makeRegistry(executed),
      continueOnApprovalTimeout: true,
    });

    const res = await loop.run("committe le travail");

    // Le tour va jusqu'à sa conclusion au lieu de mourir sur l'attente.
    expect(res.stopReason).toBe("complete");
    expect(res.finalMessage).toContain("je laisse la main");
    // Le fail-closed tient : l'outil dangereux n'a JAMAIS tourné sans verdict.
    expect(executed).toEqual([]);
  });

  it("ON : le même outil ne fait pas attendre une seconde fois", async () => {
    const executed: string[] = [];
    const channel = makeSilentChannel();
    const loop = makeLoop({
      channel,
      registry: makeRegistry(executed),
      continueOnApprovalTimeout: true,
    });

    await loop.run("committe le travail");

    // Le modèle a réessayé `git commit` une seconde fois ; UNE seule carte est
    // partie. Sans cette garde, chaque relance coûterait un timeout complet
    // (15 min en usage réel) et le remède serait pire que le mal.
    expect(channel.sentCount()).toBe(1);
  });

  it("ON : le refus est dit au modèle comme un résultat d'outil", async () => {
    const executed: string[] = [];
    const seen: Array<{ role: string; content: string }> = [];
    const registry = makeRegistry(executed);
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
      tools: registry,
      budget: createBudgetState({ maxSteps: 8, maxCostUsd: 1 }),
      approvalChannel: makeSilentChannel(),
      honestApprovalStops: true,
      approvalTimeoutMs: 60,
      approvalPollIntervalMs: 5,
      continueOnApprovalTimeout: true,
    });

    await loop.run("committe le travail");

    expect(seen.some((m) => m.content.includes("approval_timeout"))).toBe(true);
  });

  it("ON : l'attente est annoncée à l'appelant (la CLI peut la rendre visible)", async () => {
    const executed: string[] = [];
    const events: Array<{ toolName: string; timeoutMs: number }> = [];
    const loop = makeLoop({
      channel: makeSilentChannel(),
      registry: makeRegistry(executed),
      continueOnApprovalTimeout: true,
      onApprovalTimeout: (e) => events.push(e),
    });

    await loop.run("committe le travail");

    expect(events).toEqual([{ toolName: "run_bash", timeoutMs: 60 }]);
  });

  it("ON : un deny EXPLICITE arrête toujours le tour (l'humain a tranché)", async () => {
    const executed: string[] = [];
    const denying: ApprovalChannel = {
      async send() {
        return "req-1";
      },
      async poll() {
        return { approved: false, by: "founder", at: new Date().toISOString() };
      },
      async cancel() {
        /* no-op */
      },
    };
    const loop = makeLoop({
      channel: denying,
      registry: makeRegistry(executed),
      continueOnApprovalTimeout: true,
    });

    const res = await loop.run("committe le travail");

    expect(res.stopReason).toBe("approval_denied");
    expect(executed).toEqual([]);
  });
});
