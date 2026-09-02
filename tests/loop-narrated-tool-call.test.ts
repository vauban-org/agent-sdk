/**
 * Un appel d'outil ECRIT n'est pas une reponse : la boucle reprend le modele.
 *
 * Le 2026-08-30, l'assistante du founder a rendu `<brain_query q="date de
 * naissance Fabien" />` en TEXTE, sans emettre d'appel. La boucle, ne voyant
 * aucun `toolCalls`, a conclu le tour ; le modele a enchaine en inventant le
 * resultat (« Rien n'est ressorti de la premiere recherche ») et a raisonne
 * dessus. Le founder a recu une conclusion tiree d'une recherche qui n'a jamais
 * eu lieu.
 *
 * La reprise est BORNEE a une : une boucle qui insisterait sans fin serait pire
 * que le defaut qu'elle corrige. Au-dela, on laisse passer, et l'annotation du
 * rendu (`remote/gateway/unexecuted-tool-call.ts`) rend la fabrication visible.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

const NARRE =
  'Je cherche.\n\n<brain_query q="date de naissance Fabien" />\n\nRien n\'est ressorti.';

/** Narre une fois, puis se corrige des qu'il recoit la reprise. */
function makeCorrigibleProvider(): ProviderRouter {
  return {
    async complete(req) {
      const last = req.messages[req.messages.length - 1];
      const reprisRecue =
        typeof last?.content === "string" && last.content.includes("as text instead of");
      return {
        provider: "mock",
        model: "mock",
        content: reprisRecue ? "12 decembre 1979." : NARRE,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

/** Narre a chaque tour, quoi qu'on lui dise. Pire cas. */
function makeEntetéProvider(): ProviderRouter {
  return {
    async complete() {
      return {
        provider: "mock",
        model: "mock",
        content: NARRE,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

/** Repond normalement, sans jamais narrer d'outil. */
function makeSainProvider(): ProviderRouter {
  return {
    async complete() {
      return {
        provider: "mock",
        model: "mock",
        content: "12 decembre 1979.",
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
    name: "brain_query",
    description: "cherche en memoire",
    parameters: z.object({ q: z.string() }).strict(),
    execute: async () => ({ results: [] }),
  });
  return reg;
}

function build(provider: ProviderRouter): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider,
    tools: makeRegistry(),
    budget: createBudgetState({ maxSteps: 6 }),
    disableLoopDetection: true,
  });
}

describe("la boucle ne conclut pas sur un appel d'outil ecrit", () => {
  // LE CAS QUI A COUTE. Sans reprise, `finalMessage` etait le texte narre.
  it("reprend le modele, qui se corrige, et la reponse livree est la bonne", async () => {
    const r = await build(makeCorrigibleProvider()).run("ma date de naissance ?");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).toBe("12 decembre 1979.");
    expect(r.finalMessage).not.toContain("brain_query");
  });

  // La borne : sans elle, ce provider ferait tourner la boucle sans fin.
  it("ne reprend qu'une fois : un modele entete termine au lieu de boucler", async () => {
    const r = await build(makeEntetéProvider()).run("ma date de naissance ?");
    expect(r.stopReason).toBe("complete");
    // On laisse passer le texte narre : c'est l'annotation du rendu qui le
    // signale. Ce test verifie la BORNE, pas la qualite de la reponse.
    expect(r.finalMessage).toContain("brain_query");
  });

  it("non regressif : une reponse normale est rendue telle quelle, sans tour en plus", async () => {
    const r = await build(makeSainProvider()).run("ma date de naissance ?");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).toBe("12 decembre 1979.");
  });
});

/**
 * Le COUT de la reprise, du point de vue de celui qui paie.
 *
 * Les tests ci-dessus prouvent que la reprise corrige. Ceux-ci prouvent qu'elle
 * ne coute qu'un tour de plus : une reprise, c'est un appel au modele en plus,
 * donc de la latence et de l'argent. Une garde qui corrige mais qui doublerait
 * le cout de chaque conversation serait un mauvais echange, et rien ne
 * l'aurait signale.
 */
describe("la reprise ne coute qu'un tour, et seulement quand elle sert", () => {
  /** Compte les appels reellement passes au modele. */
  function compteur(contenus: string[]): { p: ProviderRouter; n: () => number } {
    let i = 0;
    return {
      n: () => i,
      p: {
        async complete() {
          const c = contenus[Math.min(i, contenus.length - 1)] ?? "";
          i += 1;
          return {
            provider: "mock",
            model: "mock",
            content: c,
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        },
      },
    };
  }

  it("NOMINAL ; une reponse propre coute UN seul appel, la garde ne s'interpose pas", async () => {
    const { p, n } = compteur(["12 decembre 1979."]);
    const r = await build(p).run("ma date de naissance ?");
    expect(r.stopReason).toBe("complete");
    expect(n()).toBe(1);
  });

  it("ALTERNATIF ; une narration corrigee coute DEUX appels, pas plus", async () => {
    const { p, n } = compteur([NARRE, "12 decembre 1979."]);
    const r = await build(p).run("ma date de naissance ?");
    expect(r.finalMessage).toBe("12 decembre 1979.");
    expect(n()).toBe(2);
  });

  // LA BORNE. Sans elle, ce provider ferait tourner la boucle jusqu'au plafond
  // de pas -- six appels au lieu de deux, sur chaque message.
  it("EXCEPTION ; un modele entete coute DEUX appels, pas six ; la borne tient", async () => {
    const { p, n } = compteur([NARRE]);
    const r = await build(p).run("ma date de naissance ?");
    expect(r.stopReason).toBe("complete");
    expect(n()).toBe(2);
    expect(n()).toBeLessThan(6);
  });
});
