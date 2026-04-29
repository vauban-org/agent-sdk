/**
 * OutcomePort conformance suite.
 *
 * Contract: recordOutcomeAsync is fire-and-forget — synchronous return
 * (void) and never throws, regardless of input validity or backend state.
 * Errors MUST be captured internally (logged, queued, etc).
 */

import type { OutcomePort } from "../ports/outcome.js";
import type { ConformanceRunner } from "./runner.js";

export interface OutcomeConformanceConfig {
  describe: ConformanceRunner["describe"];
  it: ConformanceRunner["it"];
  // biome-ignore lint/suspicious/noExplicitAny: matcher shape
  expect: any;
  factory: () => Promise<OutcomePort> | OutcomePort;
}

export function outcomePortConformance(config: OutcomeConformanceConfig): void {
  const { describe, it, expect, factory } = config;

  describe("OutcomePort conformance", () => {
    it("recordOutcomeAsync returns void synchronously", async () => {
      const outcome = await factory();
      const result = outcome.recordOutcomeAsync({
        id: "conformance-run-1",
        agent_id: "conformance-agent",
      });
      expect(result).toBe(undefined);
    });

    it("recordOutcomeAsync does not throw on missing optional fields", async () => {
      const outcome = await factory();
      let threw = false;
      try {
        outcome.recordOutcomeAsync({
          id: "conformance-run-2",
          agent_id: "conformance-agent",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    it("recordOutcomeAsync does not throw on already-attributed run", async () => {
      const outcome = await factory();
      let threw = false;
      try {
        outcome.recordOutcomeAsync({
          id: "conformance-run-3",
          agent_id: "conformance-agent",
          outcome_id: "already-set",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  });
}
