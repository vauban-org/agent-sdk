/**
 * tests/brain-traced-port.test.ts
 *
 * `createTracedBrainPort` (src/ports/brain.ts) — the BrainPort-specific OTel
 * wrapper. Distinct from the generic `tracedPort` helper covered by
 * tests/traced-port.test.ts (src/tracing/traced-port.ts); this wrapper is
 * hand-written against the `BrainPort` shape specifically (archiveKnowledge +
 * queryKnowledge spans, plane passthrough).
 *
 * Also covers `BrainRateLimitError` construction (ports/brain.ts), which no
 * other test in the suite constructs.
 */

import { describe, expect, it, vi } from "vitest";
import { type MultiBrainPort, createMultiBrainPort } from "../src/adapters/multi-brain.js";
import {
  type BrainEntry,
  type BrainEntryInput,
  type BrainPort,
  BrainRateLimitError,
  InMemoryClaimPort,
  InMemoryEpisodicMemory,
  InMemoryProceduralMemory,
  InMemorySemanticMemory,
  InMemoryWorkingMemory,
  createTracedBrainPort,
} from "../src/ports/brain.js";
import { TestBrainPort } from "../src/testing/test-brain-port.js";

describe("BrainRateLimitError", () => {
  it("carries message, retryAfterMs, and an optional cause", () => {
    const cause = new Error("upstream 429");
    const err = new BrainRateLimitError("rate limited", 2_500, cause);

    expect(err.name).toBe("BrainRateLimitError");
    expect(err.message).toBe("rate limited");
    expect(err.retryAfterMs).toBe(2_500);
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BrainRateLimitError);
  });

  it("cause is optional", () => {
    const err = new BrainRateLimitError("rate limited", 1_000);
    expect(err.cause).toBeUndefined();
  });
});

describe("createTracedBrainPort", () => {
  function baseImpl(overrides: Partial<BrainPort> = {}): BrainPort {
    return {
      archiveKnowledge: async (entry: BrainEntryInput): Promise<BrainEntry | null> => ({
        id: "entry-1",
        content: entry.content,
      }),
      ...overrides,
    };
  }

  it("archiveKnowledge: passes through on success", async () => {
    const impl = baseImpl();
    const traced = createTracedBrainPort(impl);
    const result = await traced.archiveKnowledge({ content: "hello world" });
    expect(result).toEqual({ id: "entry-1", content: "hello world" });
  });

  it("archiveKnowledge: re-throws on failure (span recorded as ERROR)", async () => {
    const boom = new Error("archive failed");
    const impl = baseImpl({
      archiveKnowledge: async () => {
        throw boom;
      },
    });
    const traced = createTracedBrainPort(impl);
    await expect(traced.archiveKnowledge({ content: "x" })).rejects.toBe(boom);
  });

  // REMPLACE, le 2026-08-29, un test qui epinglait le comportement inverse :
  // "returns [] when the wrapped impl has no queryKnowledge (feature-detected)".
  // Son nom disait feature-detection et son assertion la rendait impossible :
  // le wrapper definissait toujours la methode, donc un appelant qui teste
  // `if (port.queryKnowledge)` obtenait `true` puis une reponse vide
  // permanente. On lui repondait que la capacite EXISTE et qu'il n'y a RIEN a
  // trouver, deux faits differents dont un seul etait vrai.
  //
  // L'ancien test utilisait deja `traced.queryKnowledge?.(...)`, avec le
  // chainage optionnel : son auteur admettait que la methode puisse etre
  // absente tout en epinglant qu'elle est toujours la. Il n'est pas supprime
  // en silence, il est corrige avec sa raison.
  it("queryKnowledge: stays ABSENT when the wrapped impl has none", () => {
    const impl = baseImpl();
    expect(impl.queryKnowledge).toBeUndefined();
    const traced = createTracedBrainPort(impl);
    expect(traced.queryKnowledge).toBeUndefined();
    // La detection de capacite doit donner la meme reponse avant et apres.
    expect(Boolean(traced.queryKnowledge)).toBe(Boolean(impl.queryKnowledge));
  });

  it("queryKnowledge: passes through on success when the wrapped impl provides it", async () => {
    const queryKnowledge = vi.fn(async (): Promise<BrainEntry[]> => [{ id: "e1", content: "hit" }]);
    const impl = baseImpl({ queryKnowledge });
    const traced = createTracedBrainPort(impl);
    const results = await traced.queryKnowledge?.("q", { limit: 5 });
    expect(results).toEqual([{ id: "e1", content: "hit" }]);
    expect(queryKnowledge).toHaveBeenCalledWith("q", { limit: 5 });
  });

  it("queryKnowledge: re-throws on failure (span recorded as ERROR)", async () => {
    const boom = new Error("query failed");
    const impl = baseImpl({
      queryKnowledge: async () => {
        throw boom;
      },
    });
    const traced = createTracedBrainPort(impl);
    await expect(traced.queryKnowledge?.("q")).rejects.toBe(boom);
  });

  it("forwards the working/episodic/semantic/procedural/claims planes unchanged", () => {
    const working = new InMemoryWorkingMemory();
    const episodic = new InMemoryEpisodicMemory();
    const semantic = new InMemorySemanticMemory();
    const procedural = new InMemoryProceduralMemory();
    const claims = new InMemoryClaimPort();
    const impl = baseImpl({ working, episodic, semantic, procedural, claims });

    const traced = createTracedBrainPort(impl);
    expect(traced.working).toBe(working);
    expect(traced.episodic).toBe(episodic);
    expect(traced.semantic).toBe(semantic);
    expect(traced.procedural).toBe(procedural);
    expect(traced.claims).toBe(claims);
  });

  it("binds archivePostmortem/archiveLesson when present on the wrapped impl", async () => {
    const archivePostmortem = vi.fn(async () => undefined);
    const archiveLesson = vi.fn(async () => undefined);
    const impl = baseImpl({ archivePostmortem, archiveLesson });

    const traced = createTracedBrainPort(impl);
    expect(traced.archivePostmortem).toBeDefined();
    expect(traced.archiveLesson).toBeDefined();
    await traced.archivePostmortem?.({
      campaign_slug: "slug",
      outcome: "success",
      metrics: {},
      what_worked: [],
      what_failed: [],
      lessons: [],
    });
    await traced.archiveLesson?.({
      title: "t",
      context: "c",
      insight: "i",
      applies_to: [],
      evidence: {},
    });
    expect(archivePostmortem).toHaveBeenCalledTimes(1);
    expect(archiveLesson).toHaveBeenCalledTimes(1);
  });

  it("leaves archivePostmortem/archiveLesson undefined when absent on the wrapped impl", () => {
    const impl = baseImpl();
    const traced = createTracedBrainPort(impl);
    expect(traced.archivePostmortem).toBeUndefined();
    expect(traced.archiveLesson).toBeUndefined();
  });
});

// ─── Preservation des membres que le wrapper ne connait pas ───────────────────
//
// AJOUTE le 2026-08-29. Le wrapper reconstruisait un objet litteral avec les
// seuls champs enumeres dans son code : instrumenter un `MultiBrainPort` pour
// l'observabilite supprimait `queryAcrossBrains`, donc le seul canal qui dit
// quels Brains n'ont pas repondu. Ces tests epinglent la propriete generale
// (un membre inconnu du wrapper survit) plutot que la seule liste du jour.
describe("createTracedBrainPort ; preserve les membres inconnus du wrapper", () => {
  it("garde queryAcrossBrains et brains d'un MultiBrainPort", async () => {
    const delegate: BrainPort = {
      archiveKnowledge: async () => ({ id: "d1", content: "c" }),
      queryKnowledge: async () => [{ id: "e1", content: "found" }],
    };
    const mb = createMultiBrainPort({
      delegates: [
        { name: "personal", port: delegate, isDefault: true },
        { name: "vauban", port: delegate },
      ],
      logger: () => undefined,
    });

    const traced = createTracedBrainPort(mb) as MultiBrainPort;

    expect(typeof traced.queryAcrossBrains).toBe("function");
    expect(traced.brains).toEqual(["personal", "vauban"]);
    expect(traced.defaultBrain).toBe("personal");

    // La partialite doit rester CALCULABLE a travers le wrapper, pas seulement
    // la methode presente : c'est le fait que le port instrumente doit rendre.
    const report = await traced.queryAcrossBrains("q");
    expect(report.reached).toEqual(["personal", "vauban"]);
    expect(report.unreachable).toEqual([]);
  });

  it("rapporte un Brain injoignable a travers le wrapper", async () => {
    const ok: BrainPort = {
      archiveKnowledge: async () => null,
      queryKnowledge: async () => [{ id: "e1", content: "found" }],
    };
    const down: BrainPort = {
      archiveKnowledge: async () => null,
      queryKnowledge: async () => {
        throw new Error("connection refused");
      },
    };
    const traced = createTracedBrainPort(
      createMultiBrainPort({
        delegates: [
          { name: "personal", port: ok, isDefault: true },
          { name: "vauban", port: down },
        ],
        logger: () => undefined,
      }),
    ) as MultiBrainPort;

    const report = await traced.queryAcrossBrains("q");
    expect(report.reached).toEqual(["personal"]);
    expect(report.unreachable).toEqual([{ brain: "vauban", reason: "connection refused" }]);
  });

  it("garde les methodes de prototype d'une impl ecrite en classe", async () => {
    const impl = new TestBrainPort();
    const traced = createTracedBrainPort(impl);

    // `archiveKnowledge` est REQUIS par le contrat et vit sur le prototype :
    // toute copie par enumeration le perd en silence.
    expect(typeof traced.archiveKnowledge).toBe("function");
    const saved = await traced.archiveKnowledge({ content: "via une classe" });
    expect(saved?.content).toBe("via une classe");

    // Et l'etat prive de l'instance reste lisible : la methode doit s'executer
    // avec `this` = l'impl reelle, jamais le wrapper.
    const found = await traced.queryKnowledge?.("classe");
    expect(found?.some((e) => e.content === "via une classe")).toBe(true);
  });

  it("un membre ajoute par un sous-type quelconque survit", () => {
    const impl: BrainPort & { future: () => string } = {
      archiveKnowledge: async () => null,
      future: () => "still here",
    };
    const traced = createTracedBrainPort(impl) as BrainPort & { future: () => string };
    expect(traced.future()).toBe("still here");
  });

  it("l'identite d'une methode transmise est stable d'un acces a l'autre", () => {
    const impl = baseImplForIdentity();
    const traced = createTracedBrainPort(impl) as BrainPort & { helper: () => void };
    expect(traced.helper).toBe(traced.helper);
  });

  it("une copie par enumeration du port trace garde la version instrumentee", async () => {
    const impl: BrainPort = { archiveKnowledge: async () => ({ id: "raw", content: "c" }) };
    const traced = createTracedBrainPort(impl);
    const copy = { ...traced } as BrainPort;
    // `get` et `getOwnPropertyDescriptor` doivent s'accorder, sinon un spread
    // rend la methode NON instrumentee et le wrapper ment sur ce qu'il trace.
    expect(copy.archiveKnowledge).toBe(traced.archiveKnowledge);
    expect(copy.archiveKnowledge).not.toBe(impl.archiveKnowledge);
  });

  it("une copie par enumeration d'un port CLASSE garde encore ses methodes", async () => {
    // Le cas qui discrimine : sur une classe, `archiveKnowledge` vit sur le
    // prototype, donc `Reflect.ownKeys(impl)` ne le contient pas. Sans les
    // cles d'override dans `ownKeys` ET un descripteur rendu par
    // `getOwnPropertyDescriptor`, `{ ...traced }` perd la methode REQUISE du
    // contrat, en silence, avec le bon type.
    const traced = createTracedBrainPort(new TestBrainPort());
    const copy = { ...traced } as BrainPort;

    expect(typeof copy.archiveKnowledge).toBe("function");
    expect(typeof copy.queryKnowledge).toBe("function");
    expect(Object.keys(copy)).toContain("archiveKnowledge");
    const saved = await copy.archiveKnowledge({ content: "copie d'un port classe" });
    expect(saved?.content).toBe("copie d'un port classe");
  });

  it("ne casse pas sur une impl gelee", () => {
    const impl: BrainPort = Object.freeze({
      archiveKnowledge: async () => null,
      queryKnowledge: async () => [],
    });
    const traced = createTracedBrainPort(impl);
    expect(() => Object.keys(traced)).not.toThrow();
    expect(typeof traced.archiveKnowledge).toBe("function");
  });
});

function baseImplForIdentity(): BrainPort & { helper: () => void } {
  return {
    archiveKnowledge: async () => null,
    helper: () => undefined,
  };
}
