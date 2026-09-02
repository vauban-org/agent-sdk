/**
 * tests/brain-conformance-honesty.test.ts
 *
 * Ce que ces tests protegent : les deux suites de conformite BrainPort
 * (`testing/brain-conformance.ts`, `testing/contracts/brain-port.contract.ts`)
 * ROUGISSENT sur un port qui ne fait rien.
 *
 * Le 2026-08-29, `brainPortConformance` passait integralement sur
 * `{ archiveKnowledge: async () => null }`, y compris le test nomme
 * "archiveKnowledge returns an entry with an id on success", parce que son
 * assertion vivait derriere `if (result !== null)`. Meme motif dans le
 * contrat, avec `if (!port.working) return;` sur chaque plan optionnel : onze
 * verts pour onze capacites absentes.
 *
 * Une suite de conformite dont personne n'a jamais vu le rouge n'est pas une
 * preuve, c'est une decoration. Ces tests sont donc la mutation permanente :
 * ils EXECUTENT les suites contre des ports deliberement casses et exigent que
 * les tests NOMMES tombent.
 */

import { describe, expect, it } from "vitest";
import type { BrainPort } from "../src/ports/brain.js";
import {
  type BrainConformanceConfig,
  type BrainOptionalCapability,
  brainPortConformance,
} from "../src/testing/brain-conformance.js";
import { brainPortContract } from "../src/testing/contracts/brain-port.contract.js";
import { TestBrainPort } from "../src/testing/test-brain-port.js";

interface Verdict {
  readonly name: string;
  readonly failed: boolean;
  readonly error: string;
}

/** Joue `brainPortConformance` a la main et rend le verdict de chaque test. */
async function runConformance(
  factory: () => BrainPort | Promise<BrainPort>,
  absentCapabilities?: readonly BrainOptionalCapability[],
): Promise<Verdict[]> {
  const registered: { name: string; body: () => void | Promise<void> }[] = [];
  brainPortConformance({
    describe: (_n, body) => body(),
    it: (name, body) => registered.push({ name, body }),
    // Le vrai `expect` de vitest, la ou la config declare une forme plus large.
    expect: expect as unknown as BrainConformanceConfig["expect"],
    factory,
    ...(absentCapabilities ? { absentCapabilities } : {}),
  });
  return collect(registered);
}

/** Idem pour `brainPortContract`, via son runner injectable. */
async function runContract(
  port: BrainPort,
  absentCapabilities?: readonly BrainOptionalCapability[],
): Promise<Verdict[]> {
  const registered: { name: string; body: () => void | Promise<void> }[] = [];
  const before: (() => void | Promise<void>)[] = [];
  const after: (() => void | Promise<void>)[] = [];
  brainPortContract(async () => ({ port, cleanup: async () => undefined }), {
    ...(absentCapabilities ? { absentCapabilities } : {}),
    runner: {
      describe: (_n, body) => body(),
      it: (name, body) => registered.push({ name, body }),
      beforeAll: (body) => before.push(body),
      afterAll: (body) => after.push(body),
      expect,
    },
  });
  for (const b of before) await b();
  const verdicts = await collect(registered);
  for (const a of after) await a();
  return verdicts;
}

async function collect(
  registered: { name: string; body: () => void | Promise<void> }[],
): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const t of registered) {
    try {
      await t.body();
      out.push({ name: t.name, failed: false, error: "" });
    } catch (err) {
      out.push({
        name: t.name,
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function verdictOf(verdicts: Verdict[], namePart: string): Verdict {
  const found = verdicts.find((v) => v.name.includes(namePart));
  if (!found) {
    throw new Error(
      `aucun test nomme "${namePart}" enregistre ; noms vus : ${verdicts.map((v) => v.name).join(" | ")}`,
    );
  }
  return found;
}

/** Le port qui ne fait rien, et qui passait tout. */
const doesNothing: BrainPort = { archiveKnowledge: async () => null };

const fullyWorking = (): BrainPort => {
  let seq = 0;
  const store: { id: string; content: string; category?: string }[] = [];
  return {
    archiveKnowledge: async (entry) => {
      const saved = { id: `e-${++seq}`, content: entry.content, category: entry.category };
      store.push(saved);
      return saved;
    },
    queryKnowledge: async (q, filters) =>
      store.filter(
        (e) =>
          e.content.toLowerCase().includes(q.toLowerCase()) &&
          (!filters?.category || e.category === filters.category),
      ),
  };
};

describe("brainPortConformance ; rougit sur un port qui ne fait rien", () => {
  it("le test nomme 'returns an entry with an id on success' tombe", async () => {
    const verdicts = await runConformance(() => doesNothing);
    const v = verdictOf(verdicts, "returns an entry with an id on success");
    expect(v.failed).toBe(true);
  });

  it("le test queryKnowledge tombe quand la capacite est absente et non declaree", async () => {
    const verdicts = await runConformance(() => doesNothing);
    expect(verdictOf(verdicts, "queryKnowledge").failed).toBe(true);
  });

  it("'accepts repeated identical entries' tombe aussi sur ce port", async () => {
    const verdicts = await runConformance(() => doesNothing);
    expect(verdictOf(verdicts, "accepts repeated identical entries").failed).toBe(true);
  });

  it("un port reellement conforme reste entierement vert", async () => {
    const verdicts = await runConformance(fullyWorking);
    expect(verdicts.filter((v) => v.failed).map((v) => `${v.name}: ${v.error}`)).toEqual([]);
  });
});

describe("brainPortConformance ; la declaration d'absence est verifiee, pas crue", () => {
  const archiveOnly = (): BrainPort => {
    let seq = 0;
    return { archiveKnowledge: async (e) => ({ id: `a-${++seq}`, content: e.content }) };
  };

  it("declarer queryKnowledge absent rend un test qui DIT l'absence, et il passe", async () => {
    const verdicts = await runConformance(archiveOnly, ["queryKnowledge"]);
    const v = verdictOf(verdicts, "queryKnowledge is declared absent");
    expect(v.failed).toBe(false);
    expect(verdicts.filter((x) => x.failed)).toEqual([]);
  });

  it("declarer absent une capacite que le port possede EST une faute", async () => {
    // Sinon la declaration devient un interrupteur pour eteindre un test genant.
    const verdicts = await runConformance(fullyWorking, ["queryKnowledge"]);
    expect(verdictOf(verdicts, "queryKnowledge is declared absent").failed).toBe(true);
  });
});

describe("brainPortContract ; rougit sur les plans qu'un port n'a pas", () => {
  it("un port archive-seul, non declare partiel, fait tomber chaque plan", async () => {
    const verdicts = await runContract(doesNothing);
    expect(verdictOf(verdicts, "archives and retrieves knowledge").failed).toBe(true);
    expect(verdictOf(verdicts, "queries by category").failed).toBe(true);
    expect(verdictOf(verdicts, "supports working memory tier").failed).toBe(true);
    expect(verdictOf(verdicts, "supports episodic memory tier").failed).toBe(true);
    expect(verdictOf(verdicts, "supports the claims plane").failed).toBe(true);
  });

  it("declare partiel, il ne reste que des tests qui disent l'absence, tous verts", async () => {
    const verdicts = await runContract(fullyWorking(), ["working", "episodic", "claims"]);
    expect(verdicts.filter((v) => v.failed).map((v) => `${v.name}: ${v.error}`)).toEqual([]);
    expect(verdictOf(verdicts, "the working plane is declared absent").failed).toBe(false);
    expect(verdictOf(verdicts, "the episodic plane is declared absent").failed).toBe(false);
    expect(verdictOf(verdicts, "the claims plane is declared absent").failed).toBe(false);
  });

  it("declarer un plan absent que le port possede EST une faute", async () => {
    const verdicts = await runContract(new TestBrainPort(), ["working"]);
    expect(verdictOf(verdicts, "the working plane is declared absent").failed).toBe(true);
  });

  it("un port complet, rien de declare absent, reste entierement vert", async () => {
    const verdicts = await runContract(new TestBrainPort());
    expect(verdicts.filter((v) => v.failed).map((v) => `${v.name}: ${v.error}`)).toEqual([]);
  });
});
