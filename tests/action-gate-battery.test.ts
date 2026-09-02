/**
 * tests/action-gate-battery.test.ts
 *
 * batteryActionGate ; the seam turning VerifierBattery into a runtime pre-action
 * gate. Deterministic, no LLM. Verifies allow/deny (fail-closed) + audit step +
 * that the battery governance guards propagate.
 */

import { describe, expect, it } from "vitest";
import { batteryActionGate } from "../src/compute/battery/action-gate.js";
import type { BatteryLens } from "../src/compute/battery/types.js";
import type { ActionGateCall } from "../src/permissions/action-gate.js";
import { RecordedClock } from "../src/replay/clock.js";

const clock = () => new RecordedClock([1_700_000_000_000, 1_700_000_000_050]);

// Hard affirm rule lens: only allowlisted tools pass.
const allowlistLens: BatteryLens<ActionGateCall> = {
  verifier: {
    name: "tool-allowlist",
    evaluate: (c) => {
      const safe = ["read_file", "list_directory"].includes(c.toolName);
      return {
        score: safe ? 1 : 0,
        rationale: safe ? "tool on allowlist" : `tool ${c.toolName} not allowed`,
      };
    },
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

describe("batteryActionGate", () => {
  it("allows an action that passes the lenses, with an audit step", async () => {
    const gate = batteryActionGate<ActionGateCall>({
      lenses: [allowlistLens],
      adrEco: "ADR-ECO-045",
      clock: clock(),
      runId: "loop-1",
    });
    const v = await gate.verify({
      toolName: "read_file",
      args: { path: "x" },
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(true);
    expect(v.reason).toMatch(/accepted/);
    expect(v.auditStep).toBeDefined();
  });

  it("denies fail-closed an action the lenses kill", async () => {
    const gate = batteryActionGate<ActionGateCall>({
      lenses: [allowlistLens],
      adrEco: "ADR-ECO-045",
      clock: clock(),
      runId: "loop-1",
    });
    const v = await gate.verify({
      toolName: "run_bash",
      args: { cmd: "rm -rf /" },
      budgetUsed: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/denied/);
    expect(v.auditStep).toBeDefined();
  });

  it("propagates the battery governance guards (mandatory adrEco)", async () => {
    const gate = batteryActionGate<ActionGateCall>({
      lenses: [allowlistLens],
      adrEco: "",
      clock: clock(),
      runId: "loop-1",
    });
    await expect(gate.verify({ toolName: "read_file", args: {}, budgetUsed: 0 })).rejects.toThrow(
      /adrEco/,
    );
  });
});
