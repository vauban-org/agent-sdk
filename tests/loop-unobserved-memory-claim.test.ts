/**
 * La boucle ne conclut pas sur un verdict de memoire que personne n'a etabli.
 *
 * L'INCIDENT. Le 2026-08-31 a 16:02 UTC, le founder demande « comment je prends
 * mon cafe ? ». Son assistante repond « Laisse-moi verifier dans ma memoire [...]
 * Je n'ai rien trouve dans mes notes ». Le run tient en UNE etape et n'appelle
 * AUCUN outil (journaux de la passerelle : quatre tours, zero appel). Elle
 * annonce une recherche, ne la fait pas, et en rapporte le resultat.
 *
 * C'est le frere de `loop-narrated-tool-call.test.ts`, en plus difficile : la
 * veille, le modele ECRIVAIT la syntaxe de l'outil, ce qui laissait une trace.
 * Ici il n'ecrit que de la prose, et rien dans le message ne distingue « j'ai
 * cherche, il n'y a rien » de « je n'ai pas cherche ». Le founder tire la meme
 * conclusion dans les deux cas : ma memoire est vide.
 *
 * Ces tests pilotent la VRAIE boucle. Ils sont nommes par la promesse tenue au
 * founder, pas par la mecanique.
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

/** Le message exact rendu au founder le 2026-08-31, sans aucun appel derriere. */
const VERDICT_SANS_RECHERCHE =
  "Laisse-moi verifier dans ma memoire ce que je sais sur ton cafe. Une seconde.\n\n" +
  "Je n'ai rien trouve dans mes notes sur tes preferences cafe.";

const REPONSE_HONNETE = "Je ne sais pas encore comment tu le prends. Tu me le dis ?";

type Tour = { content: string; toolCalls?: Array<{ id: string; name: string; args: unknown }> };

/** Joue une liste de tours ; repete le dernier une fois la liste epuisee. */
function scripte(tours: Tour[]): { p: ProviderRouter; n: () => number } {
  let i = 0;
  return {
    n: () => i,
    p: {
      async complete() {
        const t = tours[Math.min(i, tours.length - 1)] ?? { content: "" };
        i += 1;
        return {
          provider: "mock",
          model: "mock",
          content: t.content,
          toolCalls: t.toolCalls ?? [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    },
  };
}

const LOOKUP: Tour["toolCalls"] = [{ id: "c1", name: "brain_query", args: { q: "cafe" } }];

function makeRegistry(opts: { lookupEchoue?: boolean } = {}): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "brain_query",
    description: "cherche en memoire",
    parameters: z.object({ q: z.string() }).strict(),
    execute: async () => {
      if (opts.lookupEchoue) throw new Error("brain unreachable");
      return { results: [] };
    },
  });
  reg.register({
    name: "brain_store",
    description: "ecrit en memoire",
    parameters: z.object({ content: z.string() }).strict(),
    execute: async () => ({ ok: true }),
  });
  return reg;
}

function build(provider: ProviderRouter, opts: { lookupEchoue?: boolean } = {}): AgentLoop {
  return new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider,
    tools: makeRegistry(opts),
    budget: createBudgetState({ maxSteps: 6 }),
    disableLoopDetection: true,
  });
}

describe("exception ; elle rend un verdict sans avoir cherche", () => {
  // LE CAS QUI A COUTE. Sans reprise, le founder recevait le verdict tel quel.
  it("la boucle la reprend, elle cherche vraiment, et le founder recoit une reponse fondee", async () => {
    const { p, n } = scripte([
      { content: VERDICT_SANS_RECHERCHE },
      { content: "Je regarde.", toolCalls: LOOKUP },
      { content: "Rien en memoire sur ton cafe. Comment tu le prends ?" },
    ]);
    const r = await build(p).run("comment je prends mon cafe ?");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).not.toContain("⚠️");
    expect(n()).toBe(3);
  });

  // LA BORNE : une garde qui insisterait sans fin serait pire que le defaut.
  it("un modele entete termine au bout d'une reprise, et son verdict part ANNOTE", async () => {
    const { p, n } = scripte([{ content: VERDICT_SANS_RECHERCHE }]);
    const r = await build(p).run("comment je prends mon cafe ?");
    expect(r.stopReason).toBe("complete");
    // On n'efface pas le message : on le qualifie. Supprimer priverait le
    // founder d'information, le laisser nu le ferait croire a une recherche.
    expect(r.finalMessage).toContain("no memory lookup ran");
    expect(r.finalMessage).toContain("Je n'ai rien trouve dans mes notes");
    expect(n()).toBe(2);
  });

  // LE TROU FERME LE 2026-08-31 : une recherche qui ECHOUE n'observe rien.
  it("un lookup en ERREUR ne vaut pas observation ; le verdict part quand meme annote", async () => {
    const { p } = scripte([
      { content: "Je regarde.", toolCalls: LOOKUP },
      { content: VERDICT_SANS_RECHERCHE },
    ]);
    const r = await build(p, { lookupEchoue: true }).run("comment je prends mon cafe ?");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).toContain("no memory lookup ran");
  });

  // ECRIRE en memoire n'etablit aucune absence.
  it("avoir ECRIT en memoire ne dispense pas d'avoir regarde", async () => {
    const { p } = scripte([
      {
        content: "Je note.",
        toolCalls: [{ id: "c9", name: "brain_store", args: { content: "x" } }],
      },
      { content: VERDICT_SANS_RECHERCHE },
    ]);
    const r = await build(p).run("comment je prends mon cafe ?");
    expect(r.finalMessage).toContain("no memory lookup ran");
  });
});

describe("nominal et alternatif ; la garde ne s'interpose pas", () => {
  it("un vide CONSTATE apres une vraie recherche part sans avertissement", async () => {
    const { p, n } = scripte([
      { content: "Je regarde.", toolCalls: LOOKUP },
      { content: VERDICT_SANS_RECHERCHE },
    ]);
    const r = await build(p).run("comment je prends mon cafe ?");
    expect(r.stopReason).toBe("complete");
    expect(r.finalMessage).not.toContain("⚠️");
    expect(n()).toBe(2);
  });

  it("« je ne sais pas » sans recherche reste intact : l'inconnu rendu honnetement", async () => {
    const { p, n } = scripte([{ content: REPONSE_HONNETE }]);
    const r = await build(p).run("comment je prends mon cafe ?");
    expect(r.finalMessage).toBe(REPONSE_HONNETE);
    expect(n()).toBe(1);
  });

  it("NON REGRESSIF ; une reponse ordinaire coute UN seul appel", async () => {
    const { p, n } = scripte([{ content: "Il est 18h02." }]);
    const r = await build(p).run("quelle heure est-il ?");
    expect(r.finalMessage).toBe("Il est 18h02.");
    expect(n()).toBe(1);
  });
});
