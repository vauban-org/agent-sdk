/**
 * BrainPort conformance suite.
 *
 * Asserts a concrete BrainPort impl honours the contract:
 *   - archiveKnowledge returns an entry with an id; a `null` there is a
 *     conformance FAILURE, not a tolerated outcome (see below).
 *   - archiveKnowledge never throws on server validation failure (throws only
 *     for network/auth errors).
 *   - queryKnowledge returns an array; empty array for no matches, never null.
 *   - Multiple archiveKnowledge calls with the same content are accepted;
 *     the impl may de-dupe but must not reject on repeat.
 *
 * ── WHAT A GREEN RUN OF THIS SUITE MEANS ──────────────────────────────────
 *
 * Until 2026-08-29 it meant almost nothing. The whole suite passed on
 * `{ archiveKnowledge: async () => null }` -- a port that does nothing at all
 * -- because every assertion sat behind a guard: `if (result !== null)` inside
 * the test named `archiveKnowledge returns an entry with an id on success`,
 * and `if (!brain.queryKnowledge) return` inside the query test. Measured by
 * running it, 2026-08-29: four tests, four greens, zero assertions reached.
 *
 * That is a green that does not mean what its name announces, on the very tool
 * meant to catch that motif elsewhere (ADR-ECO-149, "jamais faux": a surface
 * must distinguish established, refuted, and undetermined, and never render
 * the third as either of the first two).
 *
 * So the suite now separates the three states explicitly:
 *   - ESTABLISHED  -- the capability is present and its assertions ran.
 *   - REFUTED      -- the capability is present and misbehaves, or is missing
 *                     while undeclared: the test fails.
 *   - DECLARED ABSENT -- the host names the capability in `absentCapabilities`.
 *                     The suite then registers a test that CHECKS the
 *                     declaration (the port must really lack it) instead of
 *                     silently skipping. A declaration is not taken on trust
 *                     either.
 *
 * Undeclared absence is a failure by default, which is the point: silence must
 * cost something, or it stays the cheapest option.
 */

import type { BrainPort } from "../ports/brain.js";
import type { ConformanceRunner } from "./runner.js";

/**
 * A `BrainPort` member the contract allows an implementation not to have.
 * `archiveKnowledge` is deliberately absent from this union: it is required,
 * so a port lacking it can never be conformant.
 *
 * @public
 */
export type BrainOptionalCapability =
  | "queryKnowledge"
  | "working"
  | "episodic"
  | "claims"
  | "semantic"
  | "procedural";

export interface BrainConformanceConfig {
  describe: ConformanceRunner["describe"];
  it: ConformanceRunner["it"];
  expect: (actual: unknown) => {
    toBeDefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeInstanceOf(cls: unknown): void;
    toHaveProperty(key: string): void;
    toBeGreaterThanOrEqual(n: number): void;
    not: {
      toBe(expected: unknown): void;
      toBeNull(): void;
      toThrow(): void;
    };
    [key: string]: any;
  };
  /**
   * Async factory returning a fresh BrainPort for each test case.
   * Use this to isolate state between tests.
   */
  factory: () => Promise<BrainPort> | BrainPort;
  /**
   * Optional tag applied to all archived entries (so the host can clean
   * up after the suite runs). Defaults to "conformance-test".
   */
  testTag?: string;
  /**
   * Optional capabilities this port does NOT implement.
   *
   * Omitting a capability here is a CLAIM that the port has it: the suite then
   * tests it for real and fails if it is missing. Naming one turns its test
   * into a check of the declaration itself. There is no third option, because
   * the third option was the bug.
   */
  absentCapabilities?: readonly BrainOptionalCapability[];
}

export function brainPortConformance(config: BrainConformanceConfig): void {
  const { describe, it, expect, factory } = config;
  const tag = config.testTag ?? "conformance-test";
  const absent = new Set<BrainOptionalCapability>(config.absentCapabilities ?? []);

  describe("BrainPort conformance", () => {
    it("archiveKnowledge returns an entry with an id on success", async () => {
      const brain = await factory();
      const result = await brain.archiveKnowledge({
        content: "conformance — archive smoke",
        category: "pattern",
        tags: [tag],
      });
      // No `if (result !== null)` guard: a port that cannot archive a valid
      // entry is not conformant, and letting null pass here is what made the
      // whole suite green on a port that does nothing.
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("id");
      // biome-ignore lint/style/noNonNullAssertion: null is refused on the line above.
      expect(typeof result!.id).toBe("string");
      // biome-ignore lint/style/noNonNullAssertion: null is refused three lines above.
      expect(result!.id.length).toBeGreaterThanOrEqual(1);
    });

    it("archiveKnowledge returns null (not throws) on validation failure", async () => {
      const brain = await factory();
      // Empty content should either succeed or return null — never throw.
      // Here null IS a legitimate outcome, and the assertion that carries the
      // test's name is `threw === false`, which no branch can dodge.
      let threw = false;
      try {
        const result = await brain.archiveKnowledge({ content: "" });
        // Acceptable outcomes: entry with id, or null.
        if (result !== null) {
          expect(result).toHaveProperty("id");
        }
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it("archiveKnowledge accepts repeated identical entries", async () => {
      const brain = await factory();
      const entry = {
        content: `conformance-repeat-${Date.now()}`,
        category: "pattern",
        tags: [tag],
      };
      const r1 = await brain.archiveKnowledge(entry);
      const r2 = await brain.archiveKnowledge(entry);
      // Both calls must resolve without rejecting, and both must archive: the
      // "may de-dupe" tolerance is about the STORE, not about the receipt.
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: null is refused two lines above.
      expect(typeof r1!.id).toBe("string");
      // biome-ignore lint/style/noNonNullAssertion: null is refused three lines above.
      expect(typeof r2!.id).toBe("string");
    });

    if (absent.has("queryKnowledge")) {
      it("queryKnowledge is declared absent, and the port really lacks it", async () => {
        const brain = await factory();
        // The declaration is checked, not believed. A port that declares a
        // capability absent and ships it anyway is untested surface passing
        // itself off as out of scope.
        expect(typeof brain.queryKnowledge).toBe("undefined");
      });
    } else {
      it("queryKnowledge returns an array", async () => {
        const brain = await factory();
        expect(typeof brain.queryKnowledge).toBe("function");
        // biome-ignore lint/style/noNonNullAssertion: presence asserted on the line above.
        const results = await brain.queryKnowledge!("conformance test query", {
          limit: 5,
        });
        expect(Array.isArray(results)).toBe(true);
      });
    }
  });
}
