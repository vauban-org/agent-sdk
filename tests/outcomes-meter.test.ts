/**
 * tests/outcomes-meter.test.ts
 *
 * Sprint-563: B7 — AgentMeter + OutcomeGate + verifyChain.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AgentMeter, validateOutcome } from "../src/outcomes/meter.js";

describe("AgentMeter", () => {
  let meter: AgentMeter;

  beforeEach(() => {
    meter = new AgentMeter();
  });

  it("records runs to append-only ledger", () => {
    const entry = meter.recordRun("run-1", "agent-a", 100);
    expect(entry.agentId).toBe("agent-a");
    expect(entry.valueCents).toBe(100);
    expect(entry.prevHash).toBe("genesis");
  });

  it("maintains chain with prevHash linking", () => {
    const e1 = meter.recordRun("run-1", "agent-a", 100);
    const e2 = meter.recordRun("run-2", "agent-a", -50);

    expect(e2.prevHash).toBe(e1.hash);
  });

  it("getBalance returns aggregated stats", () => {
    meter.recordRun("run-1", "agent-a", 100);
    meter.recordRun("run-2", "agent-a", -30);
    meter.recordRun("run-3", "agent-b", 200);

    const balance = meter.getBalance("agent-a");
    expect(balance.totalRuns).toBe(2);
    expect(balance.totalValueCents).toBe(130);
    expect(balance.netValueCents).toBe(70);
  });

  it("getBalance with since filter", async () => {
    meter.recordRun("run-1", "agent-a", 100);
    // Small delay to ensure timestamp separation
    await new Promise((r) => setTimeout(r, 5));
    const midPoint = Date.now();
    meter.recordRun("run-2", "agent-a", 50);

    const balance = meter.getBalance("agent-a", midPoint);
    expect(balance.totalRuns).toBe(1);
    expect(balance.netValueCents).toBe(50);
  });

  it("returns zero balance for unknown agent", () => {
    const balance = meter.getBalance("nonexistent");
    expect(balance.totalRuns).toBe(0);
    expect(balance.netValueCents).toBe(0);
  });

  it("verifyChain returns valid for empty ledger", () => {
    const result = meter.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(0);
  });

  it("verifyChain returns valid for intact chain", () => {
    meter.recordRun("run-1", "agent-a", 100);
    meter.recordRun("run-2", "agent-a", 50);

    const result = meter.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(2);
  });

  it("verifyChain detects tampered entry", () => {
    meter.recordRun("run-1", "agent-a", 100);
    meter.recordRun("run-2", "agent-a", 50);

    // Tamper with first entry
    const entries = meter.export();
    entries[0]!.valueCents = 999;

    const meter2 = new AgentMeter();
    meter2.import(entries);

    const result = meter2.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.firstInvalidAt).toBe(0);
  });

  it("export/import roundtrips", () => {
    meter.recordRun("run-1", "agent-a", 100);
    const exported = meter.export();

    const meter2 = new AgentMeter();
    meter2.import(exported);

    expect(meter2.export()).toHaveLength(1);
    expect(meter2.verifyChain().valid).toBe(true);
  });
});

describe("validateOutcome", () => {
  it("allows valid outcomes", () => {
    const result = validateOutcome(
      { valueCents: 50 },
      {
        agentId: "a",
        totalRuns: 0,
        totalValueCents: 0,
        netValueCents: 0,
        firstRunAt: 0,
        lastRunAt: 0,
      },
    );
    expect(result.allowed).toBe(true);
    expect(result.chargeableCents).toBe(50);
  });

  it("rejects value below minimum", () => {
    const result = validateOutcome(
      { valueCents: 5 },
      {
        agentId: "a",
        totalRuns: 0,
        totalValueCents: 0,
        netValueCents: 0,
        firstRunAt: 0,
        lastRunAt: 0,
      },
      { minValueCents: 10 },
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects value above maximum", () => {
    const result = validateOutcome(
      { valueCents: 500 },
      {
        agentId: "a",
        totalRuns: 0,
        totalValueCents: 0,
        netValueCents: 0,
        firstRunAt: 0,
        lastRunAt: 0,
      },
      { maxValueCents: 200 },
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects cumulative exceedance", () => {
    const result = validateOutcome(
      { valueCents: 600 },
      {
        agentId: "a",
        totalRuns: 5,
        totalValueCents: 500,
        netValueCents: 500,
        firstRunAt: 0,
        lastRunAt: 1000,
      },
      { maxCumulativeCents: 1000 },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Cumulative");
  });

  it("uses 0 as chargeable floor for negative outcomes", () => {
    const result = validateOutcome(
      { valueCents: -10 },
      {
        agentId: "a",
        totalRuns: 0,
        totalValueCents: 0,
        netValueCents: 0,
        firstRunAt: 0,
        lastRunAt: 0,
      },
    );
    expect(result.allowed).toBe(true);
    expect(result.chargeableCents).toBe(0);
  });
});
