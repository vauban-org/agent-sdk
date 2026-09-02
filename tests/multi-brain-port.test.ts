/**
 * MultiBrainPort — the read/write asymmetry, under test.
 *
 * These tests exist for one reason: a read from the wrong Brain is a labelled
 * answer, and a write to the wrong Brain is a disclosure that the return value
 * calls "saved". Everything below either proves a read says where it came
 * from, or proves a write refuses to guess.
 */

import { describe, expect, it, vi } from "vitest";
import { createHttpBrainAdapter } from "../src/adapters/brain-http.js";
import {
  BRAIN_ORIGIN_METADATA_KEY,
  type MultiBrainDelegate,
  brainOriginOf,
  createMultiBrainPort,
  createMultiBrainPortFromEnv,
} from "../src/adapters/multi-brain.js";
import {
  type BrainEntry,
  type BrainEntryInput,
  type BrainPort,
  BrainUnavailableError,
  InMemoryClaimPort,
  MemoryValidationError,
} from "../src/ports/brain.js";

// ─── A minimal in-memory delegate, so the fan-out is tested and not the wire ──

interface FakeBrain extends BrainPort {
  readonly written: BrainEntryInput[];
  readonly asked: string[];
}

function fakeBrain(name: string, entries: BrainEntry[] = []): FakeBrain {
  const written: BrainEntryInput[] = [];
  const asked: string[] = [];
  return {
    written,
    asked,
    async archiveKnowledge(entry) {
      written.push(entry);
      return { id: `${name}-${written.length}`, content: entry.content };
    },
    async queryKnowledge(q) {
      asked.push(q);
      return entries;
    },
  };
}

/** A Brain that is down: every call rejects. */
function deadBrain(reason: string): BrainPort {
  return {
    async archiveKnowledge() {
      throw new Error(reason);
    },
    async queryKnowledge() {
      throw new Error(reason);
    },
  };
}

const quiet = () => {};

function twoBrains(): {
  personal: FakeBrain;
  vauban: FakeBrain;
  delegates: MultiBrainDelegate[];
} {
  const personal = fakeBrain("personal", [{ id: "p1", content: "a personal note" }]);
  const vauban = fakeBrain("vauban", [{ id: "v1", content: "a shared decision" }]);
  return {
    personal,
    vauban,
    delegates: [
      { name: "personal", port: personal, isDefault: true },
      { name: "vauban", port: vauban },
    ],
  };
}

// ─── The contract ─────────────────────────────────────────────────────────────

describe("MultiBrainPort satisfies BrainPort, so no call site changes", () => {
  it("is assignable to BrainPort and answers both of its methods", async () => {
    const { delegates } = twoBrains();
    // The typed assignment IS the contract assertion: if the shape drifted,
    // this file would not compile.
    const port: BrainPort = createMultiBrainPort({ delegates, logger: quiet });
    const saved = await port.archiveKnowledge({ content: "x" });
    expect(saved?.id).toBe("personal-1");
    expect(await port.queryKnowledge?.("anything")).toHaveLength(2);
  });

  it("exposes the four memory planes of the default delegate", () => {
    const { personal, vauban, delegates } = twoBrains();
    const claims = new InMemoryClaimPort();
    (personal as { claims?: unknown }).claims = claims;
    (vauban as { claims?: unknown }).claims = new InMemoryClaimPort();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    // The default delegate's, not the other one's: a plane write has the same
    // single-destination rule as archiveKnowledge and no field to name a target.
    expect(port.claims).toBe(claims);
  });

  it("names the Brains it can reach, default first", () => {
    const { delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates: [...delegates].reverse(), logger: quiet });
    expect(port.defaultBrain).toBe("personal");
    expect(port.brains).toEqual(["personal", "vauban"]);
  });
});

// ─── Reads fan out, and say where each answer came from ───────────────────────

describe("reads fan out and carry their origin", () => {
  it("asks every configured Brain", async () => {
    const { personal, vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await port.queryKnowledge?.("stark settlement");
    expect(personal.asked).toEqual(["stark settlement"]);
    expect(vauban.asked).toEqual(["stark settlement"]);
  });

  it("stamps each entry with the Brain it came from", async () => {
    const { delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    const entries = (await port.queryKnowledge?.("q")) ?? [];
    expect(entries.map(brainOriginOf).sort()).toEqual(["personal", "vauban"]);
    expect(entries[0]?.metadata?.[BRAIN_ORIGIN_METADATA_KEY]).toBe("personal");
  });

  it("keeps the caller's own metadata alongside the origin stamp", async () => {
    const one = fakeBrain("one", [{ id: "e", content: "c", metadata: { author: "fabien" } }]);
    const port = createMultiBrainPort({ delegates: [{ name: "one", port: one }], logger: quiet });
    const [entry] = (await port.queryKnowledge?.("q")) ?? [];
    expect(entry?.metadata).toMatchObject({ author: "fabien", [BRAIN_ORIGIN_METADATA_KEY]: "one" });
  });

  it("passes the filters through to every Brain", async () => {
    const seen: unknown[] = [];
    const spy: BrainPort = {
      async archiveKnowledge() {
        return null;
      },
      async queryKnowledge(_q, f) {
        seen.push(f);
        return [];
      },
    };
    const port = createMultiBrainPort({
      delegates: [
        { name: "a", port: spy },
        { name: "b", port: spy },
      ],
      logger: quiet,
    });
    await port.queryKnowledge?.("q", { limit: 3, tags: ["gtm"] });
    expect(seen).toEqual([
      { limit: 3, tags: ["gtm"] },
      { limit: 3, tags: ["gtm"] },
    ]);
  });

  it("does not guess an origin for an entry that never passed through", () => {
    expect(brainOriginOf({ id: "x", content: "c" })).toBeUndefined();
  });
});

// ─── A Brain that is down must not silence the ones that are up ───────────────

describe("one Brain down is an absence FROM THAT BRAIN, reported", () => {
  it("still returns the other Brains' results", async () => {
    const { personal, delegates } = twoBrains();
    delegates[1] = { name: "vauban", port: deadBrain("ECONNREFUSED brain-api") };
    const port = createMultiBrainPort({ delegates, logger: quiet });
    const report = await port.queryAcrossBrains("q");
    expect(report.entries).toHaveLength(1);
    expect(brainOriginOf(report.entries[0] as BrainEntry)).toBe("personal");
    expect(personal.asked).toEqual(["q"]);
  });

  it("names the Brain that did not answer, and why", async () => {
    const { delegates } = twoBrains();
    delegates[1] = { name: "vauban", port: deadBrain("ECONNREFUSED brain-api") };
    const port = createMultiBrainPort({ delegates, logger: quiet });
    const report = await port.queryAcrossBrains("q");
    expect(report.reached).toEqual(["personal"]);
    expect(report.unreachable).toEqual([{ brain: "vauban", reason: "ECONNREFUSED brain-api" }]);
  });

  it("warns through the injected logger rather than swallowing the failure", async () => {
    const { delegates } = twoBrains();
    delegates[1] = { name: "vauban", port: deadBrain("boom") };
    const logger = vi.fn();
    const port = createMultiBrainPort({ delegates, logger });
    await port.queryAcrossBrains("q");
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("vauban"));
  });

  // A partial failure must not throw: that would discard real results in order
  // to report a fault the caller can already see on queryAcrossBrains.
  it("does not throw on a partial failure", async () => {
    const { delegates } = twoBrains();
    delegates[1] = { name: "vauban", port: deadBrain("boom") };
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await expect(port.queryKnowledge?.("q")).resolves.toHaveLength(1);
  });

  // THE CLAUSE THAT MATTERS on the read side. `[]` from a BrainPort reads as
  // "nothing is known", and a model will say so out loud. When nothing was
  // actually searched, that sentence is false.
  it("THROWS rather than return [] when no Brain answered at all", async () => {
    const port = createMultiBrainPort({
      delegates: [
        { name: "personal", port: deadBrain("down-1") },
        { name: "vauban", port: deadBrain("down-2") },
      ],
      logger: quiet,
    });
    await expect(port.queryKnowledge?.("q")).rejects.toBeInstanceOf(BrainUnavailableError);
    await expect(port.queryKnowledge?.("q")).rejects.toThrow(/down-1[\s\S]*down-2/);
    // queryAcrossBrains still reports it structurally, without throwing.
    const report = await port.queryAcrossBrains("q");
    expect(report.reached).toEqual([]);
    expect(report.unreachable).toHaveLength(2);
  });

  it("returns an empty answer, without throwing, when the Brains DID answer with nothing", async () => {
    const port = createMultiBrainPort({
      delegates: [{ name: "personal", port: fakeBrain("personal", []) }],
      logger: quiet,
    });
    await expect(port.queryKnowledge?.("q")).resolves.toEqual([]);
  });

  // A delegate with no queryKnowledge was NOT searched. Counting it as a Brain
  // that answered with nothing would render an absence as a fact.
  it("reports a delegate that cannot query as unsearched, not as empty", async () => {
    const port = createMultiBrainPort({
      delegates: [
        { name: "personal", port: fakeBrain("personal", [{ id: "p", content: "c" }]) },
        {
          name: "writeonly",
          port: {
            async archiveKnowledge() {
              return null;
            },
          },
        },
      ],
      logger: quiet,
    });
    const report = await port.queryAcrossBrains("q");
    expect(report.reached).toEqual(["personal"]);
    expect(report.unreachable[0]?.brain).toBe("writeonly");
    expect(report.unreachable[0]?.reason).toContain("queryKnowledge");
  });
});

// ─── Writes: one destination, named or refused ────────────────────────────────

describe("writes go to ONE destination and never guess", () => {
  it("writes to the default Brain when none is named", async () => {
    const { personal, vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await port.archiveKnowledge({ content: "a personal note" });
    expect(personal.written).toHaveLength(1);
    expect(vauban.written).toHaveLength(0);
  });

  it("writes to a named Brain when the caller names it", async () => {
    const { personal, vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    const saved = await port.archiveKnowledge({ content: "a shared decision", brain: "vauban" });
    expect(vauban.written).toHaveLength(1);
    expect(personal.written).toHaveLength(0);
    expect(saved?.id).toBe("vauban-1");
  });

  // "saved: true" alone leaves a caller with several Brains unable to tell
  // WHICH memory now holds the note.
  it("returns a receipt saying which Brain the write landed in", async () => {
    const { delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    expect(brainOriginOf((await port.archiveKnowledge({ content: "x" })) as BrainEntry)).toBe(
      "personal",
    );
    const receipt = await port.archiveKnowledge({ content: "y", brain: "vauban" });
    expect(brainOriginOf(receipt as BrainEntry)).toBe("vauban");
  });

  it("accepts the name as a human would type it", async () => {
    const { vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await port.archiveKnowledge({ content: "x", brain: "  Vauban " });
    expect(vauban.written).toHaveLength(1);
  });

  // THE CLAUSE THAT MATTERS on the write side. Defaulting on a typo turns a
  // slip into a note filed in the wrong memory, and the caller is told "saved".
  it("REFUSES an unknown name instead of falling back to the default", async () => {
    const { personal, vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await expect(port.archiveKnowledge({ content: "secret", brain: "vaubanne" })).rejects.toThrow(
      MemoryValidationError,
    );
    // And nothing was written ANYWHERE. A refusal that still wrote somewhere
    // would be worse than a silent default.
    expect(personal.written).toEqual([]);
    expect(vauban.written).toEqual([]);
  });

  it("names the Brains that DO exist, so the caller can correct itself", async () => {
    const { delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await expect(port.archiveKnowledge({ content: "x", brain: "nope" })).rejects.toThrow(
      /nope[\s\S]*personal[\s\S]*vauban/,
    );
  });

  // `brain` is routing, not payload: a wire adapter has no such column and a
  // strict server schema would reject the write outright.
  it("strips the routing field before the delegate sees it", async () => {
    const { vauban, delegates } = twoBrains();
    const port = createMultiBrainPort({ delegates, logger: quiet });
    await port.archiveKnowledge({ content: "x", category: "decision", brain: "vauban" });
    expect(vauban.written[0]).toEqual({ content: "x", category: "decision" });
    expect(vauban.written[0]).not.toHaveProperty("brain");
  });

  it("routes post-mortems and lessons to the default Brain too", async () => {
    const calls: string[] = [];
    const withHelpers = (name: string): BrainPort => ({
      async archiveKnowledge() {
        return null;
      },
      async archivePostmortem() {
        calls.push(`${name}:postmortem`);
      },
      async archiveLesson() {
        calls.push(`${name}:lesson`);
      },
    });
    const port = createMultiBrainPort({
      delegates: [
        { name: "personal", port: withHelpers("personal"), isDefault: true },
        { name: "vauban", port: withHelpers("vauban") },
      ],
      logger: quiet,
    });
    await port.archivePostmortem?.({
      campaign_slug: "c",
      outcome: "success",
    } as Parameters<NonNullable<BrainPort["archivePostmortem"]>>[0]);
    await port.archiveLesson?.({ applies_to: ["gtm"] } as Parameters<
      NonNullable<BrainPort["archiveLesson"]>
    >[0]);
    expect(calls).toEqual(["personal:postmortem", "personal:lesson"]);
  });

  it("leaves the optional helpers absent when the default Brain has none", () => {
    const port = createMultiBrainPort({
      delegates: [{ name: "personal", port: fakeBrain("personal") }],
      logger: quiet,
    });
    expect(port.archivePostmortem).toBeUndefined();
    expect(port.archiveLesson).toBeUndefined();
  });
});

// ─── Configuration bugs are loud, because their quiet form misfiles a write ───

describe("construction refuses an ambiguous roster", () => {
  it("refuses an empty roster", () => {
    expect(() => createMultiBrainPort({ delegates: [] })).toThrow(MemoryValidationError);
  });

  it("refuses two Brains sharing a name", () => {
    const { personal, vauban } = twoBrains();
    expect(() =>
      createMultiBrainPort({
        delegates: [
          { name: "vauban", port: personal },
          { name: "Vauban", port: vauban },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("refuses two default destinations, because there is exactly one", () => {
    const { personal, vauban } = twoBrains();
    expect(() =>
      createMultiBrainPort({
        delegates: [
          { name: "personal", port: personal, isDefault: true },
          { name: "vauban", port: vauban, isDefault: true },
        ],
      }),
    ).toThrow(/more than one default/);
  });

  it("takes the first Brain as the default when none is flagged", async () => {
    const { personal, vauban } = twoBrains();
    const port = createMultiBrainPort({
      delegates: [
        { name: "personal", port: personal },
        { name: "vauban", port: vauban },
      ],
      logger: quiet,
    });
    await port.archiveKnowledge({ content: "x" });
    expect(personal.written).toHaveLength(1);
  });
});

// ─── From the environment ─────────────────────────────────────────────────────

describe("createMultiBrainPortFromEnv", () => {
  it("returns undefined when no Brain is configured", () => {
    expect(createMultiBrainPortFromEnv({}, { logger: quiet })).toBeUndefined();
  });

  it("builds one delegate per configured Brain", () => {
    const port = createMultiBrainPortFromEnv(
      {
        BRAIN_API_KEY: "k",
        BRAIN_VAUBAN_ID: "v",
        BRAIN_VAUBAN_API_KEY: "vk",
      },
      { logger: quiet },
    );
    expect(port?.brains).toEqual(["default", "vauban"]);
    expect(port?.defaultBrain).toBe("default");
  });

  // A Brain declared with an id and no credential 401s on every call: it looks
  // configured and is not. Dropping it is right; dropping it in silence is not.
  it("drops an incomplete Brain and reports the reason through the logger", () => {
    const logger = vi.fn();
    const port = createMultiBrainPortFromEnv(
      { BRAIN_API_KEY: "k", BRAIN_VAUBAN_ID: "v" },
      { logger },
    );
    expect(port?.brains).toEqual(["default"]);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("BRAIN_VAUBAN_API_KEY"));
  });

  it("never builds a delegate on an empty credential", () => {
    const port = createMultiBrainPortFromEnv(
      { BRAIN_API_KEY: "k", BRAIN_VAUBAN_ID: "v", BRAIN_VAUBAN_API_KEY: "" },
      { logger: quiet },
    );
    expect(port?.brains).toEqual(["default"]);
  });
});

// ─── The single-Brain adapter, and the honesty its fan-out depends on ─────────

describe("createHttpBrainAdapter, as a MultiBrainPort delegate", () => {
  function stubFetch(impl: () => Promise<Response> | Response) {
    const f = vi.fn(impl);
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("refuses a routed write, because it is bound to a single Brain", async () => {
    const fetchSpy = stubFetch(() => {
      throw new Error("must not be called");
    });
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "k",
      logger: quiet,
    });
    await expect(adapter.archiveKnowledge({ content: "x", brain: "vauban" })).rejects.toThrow(
      MemoryValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("still writes normally when no destination is named", async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { id: "e1", content: "x" } }),
        }) as Response,
    );
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "k",
      logger: quiet,
    });
    await expect(adapter.archiveKnowledge({ content: "x" })).resolves.toMatchObject({ id: "e1" });
    vi.unstubAllGlobals();
  });

  // Without this, a dead Brain reaches the fan-out as "answered, no results",
  // and `unreachable` becomes a field that can never be populated.
  it("throws on a failed query when the fan-out asks it to", async () => {
    stubFetch(async () => ({ ok: false, status: 503, text: async () => "" }) as Response);
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "k",
      logger: quiet,
      throwOnQueryFailure: true,
    });
    await expect(adapter.queryKnowledge?.("q")).rejects.toBeInstanceOf(BrainUnavailableError);
    vi.unstubAllGlobals();
  });

  it("keeps the historical fail-soft empty array by default", async () => {
    stubFetch(async () => ({ ok: false, status: 503, text: async () => "" }) as Response);
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "k",
      logger: quiet,
    });
    await expect(adapter.queryKnowledge?.("q")).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it("returns an empty array, not a throw, when the Brain answers with no rows", async () => {
    stubFetch(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) }) as Response,
    );
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "k",
      logger: quiet,
      throwOnQueryFailure: true,
    });
    await expect(adapter.queryKnowledge?.("q")).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it("does not leak the credential into the failure message", async () => {
    stubFetch(async () => ({ ok: false, status: 401, text: async () => "" }) as Response);
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.example",
      brainId: "b",
      apiKey: "super-secret-key",
      logger: quiet,
      throwOnQueryFailure: true,
    });
    const err = await adapter.queryKnowledge?.("q").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(BrainUnavailableError);
    expect(err?.message).not.toContain("super-secret-key");
    expect(err?.message).toContain("https://brain.example");
    vi.unstubAllGlobals();
  });
});
