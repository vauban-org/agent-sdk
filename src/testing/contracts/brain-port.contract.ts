/**
 * BrainPort contract test suite.
 *
 * Forge adapters (PostgresBrainAdapter) run this suite to validate
 * semantic correctness, not just type conformance.
 *
 * ── WHAT A GREEN RUN MEANS, and what it used to mean ──────────────────────
 *
 * Every optional-capability test in here opened with `if (!port.working)
 * return;`. A port implementing only `archiveKnowledge` therefore reported
 * eleven greens for eleven capabilities it does not have. Same defect, same
 * day, as `brain-conformance.ts` (see its header): a green that does not mean
 * what its name announces, on the tool meant to catch that motif.
 *
 * The suite now demands a declaration. Omitting a capability from
 * `absentCapabilities` is a CLAIM that the port implements it, and the suite
 * fails when it does not. Naming one replaces its tests with a single check
 * that the port really lacks it, under a name that says so. The three states
 * ADR-ECO-149 requires -- established, refuted, undetermined -- are then
 * distinguishable from the test report alone.
 *
 * Usage in Forge:
 * ```typescript
 * import { brainPortContract } from "@vauban-org/agent-sdk/testing/contracts";
 * brainPortContract(
 *   async () => {
 *     const port = new PostgresBrainAdapter(testPool);
 *     return { port, cleanup: () => testPool.end() };
 *   },
 *   // PostgresBrainAdapter implements archive + query only.
 *   { absentCapabilities: ["working", "episodic", "claims"] },
 * );
 * ```
 *
 * @public
 */

import {
  afterAll as vitestAfterAll,
  beforeAll as vitestBeforeAll,
  describe as vitestDescribe,
  expect as vitestExpect,
  it as vitestIt,
} from "vitest";
import type { BrainPort } from "../../ports/brain.js";
import type { BrainOptionalCapability } from "../brain-conformance.js";

/**
 * The slice of a test runner this suite uses. Injectable for ONE reason: a
 * conformance suite that cannot be run against a deliberately broken port is a
 * suite nobody has ever seen fail, which is the same class of unfounded trust
 * it exists to catch. `tests/brain-conformance-honesty.test.ts` uses this to
 * assert that the named tests below really do go red.
 *
 * @public
 */
export interface BrainContractRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => void | Promise<void>): void;
  beforeAll(body: () => void | Promise<void>): void;
  afterAll(body: () => void | Promise<void>): void;
  /** Matcher factory. Typed against vitest's `expect`, which is the default. */
  expect: typeof vitestExpect;
}

/** @public */
export interface BrainPortContractOptions {
  /**
   * Capabilities the port under test does NOT implement. Anything left out is
   * asserted present and exercised for real.
   */
  readonly absentCapabilities?: readonly BrainOptionalCapability[];
  /** Test runner. Defaults to vitest; override only to test this suite itself. */
  readonly runner?: BrainContractRunner;
}

export function brainPortContract(
  factory: () => Promise<{ port: BrainPort; cleanup(): Promise<void> }>,
  options: BrainPortContractOptions = {},
): void {
  const { describe, it, beforeAll, afterAll, expect } = options.runner ?? {
    describe: vitestDescribe,
    it: vitestIt,
    beforeAll: vitestBeforeAll,
    afterAll: vitestAfterAll,
    expect: vitestExpect,
  };
  let port: BrainPort;
  let cleanup: () => Promise<void>;
  const absent = new Set<BrainOptionalCapability>(options.absentCapabilities ?? []);

  beforeAll(async () => {
    const result = await factory();
    port = result.port;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe("BrainPort contract", () => {
    it("archives and retrieves knowledge", async () => {
      const entry = await port.archiveKnowledge({
        content: "Test knowledge entry for contract validation",
        category: "forge_test",
        tags: ["test", "contract"],
        confidence: 0.9,
      });
      expect(entry).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
      expect(entry!.id).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
      expect(entry!.content).toContain("contract validation");
    });

    // ── queryKnowledge ────────────────────────────────────────────────────
    if (absent.has("queryKnowledge")) {
      it("queryKnowledge is declared absent, and the port really lacks it", () => {
        expect(port.queryKnowledge).toBeUndefined();
      });
    } else {
      it("queries by category", async () => {
        expect(typeof port.queryKnowledge).toBe("function");

        await port.archiveKnowledge({
          content: "Category-specific entry",
          category: "forge_test_category",
          tags: ["test"],
        });

        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        const results = await port.queryKnowledge!("Category", {
          category: "forge_test_category",
          limit: 5,
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].category).toBe("forge_test_category");
      });

      it("returns an empty array for non-existent queries", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        const results = await port.queryKnowledge!("nonexistent_xyz_123", { limit: 1 });
        expect(results.length).toBe(0);
      });
    }

    // ── working memory plane ──────────────────────────────────────────────
    if (absent.has("working")) {
      it("the working plane is declared absent, and the port really lacks it", () => {
        expect(port.working).toBeUndefined();
      });
    } else {
      it("supports working memory tier", async () => {
        expect(port.working).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        await port.working!.set("test-run", "key1", { value: 42 });
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        const result = await port.working!.get("test-run", "key1");
        expect(result).toEqual({ value: 42 });
      });

      it("supports working memory list(), V12-aligned slot shape", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        await port.working!.set("test-run-list", "goal", { text: "ship it" }, { pinned: true });
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        const slots = await port.working!.list("test-run-list");
        expect(slots.length).toBeGreaterThan(0);
        const slot = slots.find((s) => s.slotId === "goal");
        expect(slot).toBeDefined();
        expect(slot?.pinned).toBe(true);
        expect(typeof slot?.importanceScore).toBe("number");
      });

      it("returns an empty list() for a run with no slots", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by an earlier test in this branch.
        const slots = await port.working!.list("test-run-empty-list");
        expect(slots).toEqual([]);
      });
    }

    // ── episodic plane ────────────────────────────────────────────────────
    if (absent.has("episodic")) {
      it("the episodic plane is declared absent, and the port really lacks it", () => {
        expect(port.episodic).toBeUndefined();
      });
    } else {
      it("supports episodic memory tier", async () => {
        expect(port.episodic).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        await port.episodic!.record("test-agent", "run-1", "cycle_completed", { cycles: 5 });
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        const events = await port.episodic!.since("test-agent", Date.now() - 60_000);
        expect(events.length).toBeGreaterThan(0);
      });

      it("supports episodic append()/query(), V12-aligned event shape", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        const eventId = await port.episodic!.append(
          "test-agent-v12",
          "test-session-v12",
          "decision",
          { chose: "contract path" },
          { importanceScore: 0.9 },
        );
        expect(typeof eventId).toBe("string");

        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        const events = await port.episodic!.query({ agentId: "test-agent-v12" });
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].eventType).toBe("decision");
        expect(events[0].importanceScore).toBe(0.9);
      });

      it("episodic query() rejects an empty agentId", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by an earlier test in this branch.
        await expect(port.episodic!.query({ agentId: "" })).rejects.toThrow();
      });
    }

    // ── claims plane ──────────────────────────────────────────────────────
    if (absent.has("claims")) {
      it("the claims plane is declared absent, and the port really lacks it", () => {
        expect(port.claims).toBeUndefined();
      });
    } else {
      it("supports the claims plane, assert()/query() round-trip", async () => {
        expect(port.claims).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        const claimId = await port.claims!.assert(
          "vauban-server",
          "is-a",
          "single-node k3s cluster",
          { confidence: 0.95 },
        );
        expect(typeof claimId).toBe("string");

        // biome-ignore lint/style/noNonNullAssertion: presence asserted above.
        const claims = await port.claims!.query({ subject: "vauban-server" });
        expect(claims.length).toBeGreaterThan(0);
        expect(claims[0].predicate).toBe("is-a");
        expect(claims[0].claimStatus).toBe("active");
      });

      it("claims query() rejects a filter with no subject/predicate/object", async () => {
        // biome-ignore lint/style/noNonNullAssertion: presence asserted by the previous test in this branch.
        await expect(port.claims!.query({})).rejects.toThrow();
      });
    }
  });
}
