/**
 * BrainPort conformance suite.
 *
 * Asserts a concrete BrainPort impl honours the contract:
 *   - archiveKnowledge returns an entry-like object or null; never throws
 *     on server validation failure (throws only for network/auth errors).
 *   - queryKnowledge (when present) returns an array; empty array for no
 *     matches, never null.
 *   - Multiple archiveKnowledge calls with the same content are accepted;
 *     the impl may de-dupe but must not reject on repeat.
 */

import type { BrainPort } from "../ports/brain.js";
import type { ConformanceRunner } from "./runner.js";

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
    // biome-ignore lint/suspicious/noExplicitAny: matcher shape
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
}

export function brainPortConformance(config: BrainConformanceConfig): void {
  const { describe, it, expect, factory } = config;
  const tag = config.testTag ?? "conformance-test";

  describe("BrainPort conformance", () => {
    it("archiveKnowledge returns an entry with an id on success", async () => {
      const brain = await factory();
      const result = await brain.archiveKnowledge({
        content: "conformance — archive smoke",
        category: "pattern",
        tags: [tag],
      });
      if (result !== null) {
        expect(result).toHaveProperty("id");
        expect(typeof result.id).toBe("string");
      }
    });

    it("archiveKnowledge returns null (not throws) on validation failure", async () => {
      const brain = await factory();
      // Empty content should either succeed or return null — never throw.
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
      // Both calls must resolve without rejecting.
      expect(r1 === null || typeof r1.id === "string").toBe(true);
      expect(r2 === null || typeof r2.id === "string").toBe(true);
    });

    it("queryKnowledge (when present) returns an array", async () => {
      const brain = await factory();
      if (!brain.queryKnowledge) return; // optional port method
      const results = await brain.queryKnowledge("conformance test query", {
        limit: 5,
      });
      expect(Array.isArray(results)).toBe(true);
    });
  });
}
