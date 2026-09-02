/**
 * tests/compute-battery.test.ts
 *
 * VerifierBattery ; the governed rejection-sampling primitive.
 *
 * Golden and deterministic ; no LLM calls. Lenses score by candidate id, so the
 * N x M matrix is fully predictable. Proves the four governance properties:
 * determinism + replay (rootHash reproducibility), the audit step shape, ADR
 * traceability (mandatory adrEco), and the reject-as-proof completeness invariant.
 */

import { describe, expect, it } from "vitest";
import {
  BatteryGovernanceError,
  VERIFIER_BATTERY_GUARD,
  runVerifierBattery,
} from "../src/compute/battery/battery.js";
import type { BatteryLens, RunVerifierBatteryOptions } from "../src/compute/battery/types.js";
import { GENESIS_PREV_HASH, buildChain, verifyChain } from "../src/proof/chain.js";
import { sha256 } from "../src/proof/sha256.js";
import { RecordedClock } from "../src/replay/clock.js";
import { canonicalize } from "../src/trace/canonical.js";
import { TRACE_SCHEMA_VERSION, type Trace, type TraceStep } from "../src/trace/schema.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

type Cand = { id: number; text: string };

const cands = (n: number): Cand[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, text: `c${i}` }));

function lens(
  name: string,
  polarity: "affirm" | "refute",
  criticality: "hard" | "soft" | "advisory",
  scores: readonly number[],
  engine: BatteryLens<Cand>["signature"]["engine"] = "rule",
): BatteryLens<Cand> {
  return {
    verifier: {
      name,
      evaluate: (o) => ({
        score: scores[o.id],
        rationale: `${name}@${o.id}=${scores[o.id]}`,
      }),
    },
    polarity,
    criticality,
    signature: { engine },
  };
}

const T0 = 1_700_000_000_000;
const DURATION = 50;

function freshOpts(over: Partial<RunVerifierBatteryOptions> = {}): RunVerifierBatteryOptions {
  return {
    clock: new RecordedClock([T0, T0 + DURATION]),
    runId: "battery-run-001",
    adrEco: "ADR-ECO-045",
    ...over,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("runVerifierBattery ; happy path (affirm lenses)", () => {
  it("accepts the highest-composite candidate and rejects the rest with reasons", async () => {
    const c = cands(3);
    const v1 = lens("v1", "affirm", "soft", [0.4, 0.9, 0.6]);
    const v2 = lens("v2", "affirm", "soft", [0.5, 0.8, 0.7]);

    const d = await runVerifierBattery<Cand>("q", c, [v1, v2], freshOpts());

    // C0 mean 0.45, C1 mean 0.85 (winner), C2 mean 0.65.
    expect(d.acceptedIndex).toBe(1);
    expect(d.accepted).toEqual({ id: 1, text: "c1" });
    expect(d.acceptedScore).toBeCloseTo(0.85, 10);
    expect(d.acceptedHash).toMatch(HEX64);
    expect(d.verdicts).toHaveLength(3);
    expect(d.verdicts.every((v) => !v.killed)).toBe(true);
    expect(d.rejected).toHaveLength(2);
    expect(d.rejected.map((r) => r.candidateIndex).sort()).toEqual([0, 2]);
    expect(d.rejected.every((r) => r.reason.startsWith("not-selected"))).toBe(true);
  });

  it("emits a single hash-only guard audit step", async () => {
    const c = cands(2);
    const v = lens("v", "affirm", "soft", [0.3, 0.9]);
    const d = await runVerifierBattery<Cand>("q", c, [v], freshOpts());

    expect(d.auditStep.phase).toBe("guard");
    expect(d.auditStep.type).toBe("guard_check");
    expect(d.auditStep.guardName).toBe(VERIFIER_BATTERY_GUARD);
    expect(d.auditStep.policy).toBe("hash-only");
    expect(d.auditStep.runId).toBe("battery-run-001");
    expect(d.auditStep.timestamp).toBe(T0);
    expect(d.auditStep.durationMs).toBe(DURATION);
    expect(d.auditStep.inputHash).toMatch(HEX64);
    expect(d.auditStep.outputHash).toMatch(HEX64);
    // hash-only ; no plaintext payload retained
    expect(d.auditStep.storedInput).toBeUndefined();
    expect(d.auditStep.storedOutput).toBeUndefined();
  });
});

// ─── Refute kill ─────────────────────────────────────────────────────────────

describe("runVerifierBattery ; refute kill", () => {
  it("a hard refute lens kills the otherwise-best candidate (fail-closed)", async () => {
    const c = cands(3);
    const v = lens("affirm", "affirm", "soft", [0.4, 0.9, 0.6]);
    const r = lens("refute", "refute", "hard", [0.1, 0.95, 0.1]);

    const d = await runVerifierBattery<Cand>("q", c, [v, r], freshOpts());

    // C1 would win on affirm, but the hard refuter fires (0.95 >= 0.5) ⇒ killed.
    expect(d.verdicts[1].killed).toBe(true);
    expect(d.verdicts[1].killReason).toContain("hard refute");
    expect(d.acceptedIndex).toBe(2); // C2 composite 0.54 > C0 0.36
    const c1Reject = d.rejected.find((x) => x.candidateIndex === 1);
    expect(c1Reject?.reason).toMatch(/^killed: hard refute/);
  });

  it("a strict majority of refute lenses kills via quorum", async () => {
    const c = cands(2);
    const v = lens("affirm", "affirm", "soft", [0.9, 0.9]);
    const r1 = lens("r1", "refute", "soft", [0.9, 0.1]);
    const r2 = lens("r2", "refute", "soft", [0.9, 0.1]);
    const r3 = lens("r3", "refute", "soft", [0.1, 0.1]);

    const d = await runVerifierBattery<Cand>("q", c, [v, r1, r2, r3], freshOpts());

    // C0: 2/3 refuters fire ⇒ quorum kill. C1: 0/3 ⇒ survives.
    expect(d.verdicts[0].killed).toBe(true);
    expect(d.verdicts[0].killReason).toContain("refute quorum: 2/3");
    expect(d.acceptedIndex).toBe(1);
  });
});

// ─── Fail-closed ─────────────────────────────────────────────────────────────

describe("runVerifierBattery ; fail-closed", () => {
  it("returns accepted=null when every candidate is killed", async () => {
    const c = cands(2);
    const v = lens("affirm", "affirm", "soft", [0.9, 0.9]);
    const r = lens("refute", "refute", "hard", [0.9, 0.9]);

    const d = await runVerifierBattery<Cand>("q", c, [v, r], freshOpts());

    expect(d.accepted).toBeNull();
    expect(d.acceptedIndex).toBeNull();
    expect(d.acceptedScore).toBeNull();
    expect(d.acceptedHash).toBeNull();
    expect(d.rejected).toHaveLength(2);
    expect(d.verdicts.every((v) => v.killed)).toBe(true);
    // Still fully audited even when nothing is accepted.
    expect(d.auditStep.outputHash).toMatch(HEX64);
  });
});

// ─── Governance guards ───────────────────────────────────────────────────────

describe("runVerifierBattery ; governance guards (cargo-cult rejection)", () => {
  const c = cands(1);
  const ok = () => lens("v", "affirm", "soft", [0.9]);

  it("rejects an empty adrEco", async () => {
    await expect(
      runVerifierBattery<Cand>("q", c, [ok()], freshOpts({ adrEco: "  " })),
    ).rejects.toThrow(/adrEco is mandatory/);
  });

  it("rejects an empty runId", async () => {
    await expect(
      runVerifierBattery<Cand>("q", c, [ok()], freshOpts({ runId: "" })),
    ).rejects.toThrow(/runId is mandatory/);
  });

  it("rejects zero candidates", async () => {
    await expect(runVerifierBattery<Cand>("q", [], [ok()], freshOpts())).rejects.toThrow(
      /at least 1 candidate/,
    );
  });

  it("rejects zero lenses", async () => {
    await expect(runVerifierBattery<Cand>("q", c, [], freshOpts())).rejects.toThrow(
      /at least 1 lens/,
    );
  });

  it("rejects an advisory-only battery (gates nothing)", async () => {
    const adv = lens("adv", "affirm", "advisory", [0.9]);
    await expect(runVerifierBattery<Cand>("q", c, [adv], freshOpts())).rejects.toThrow(
      /non-advisory/,
    );
  });

  it("rejects a battery with no deterministic anchor (llm-judge only)", async () => {
    const judge = lens("judge", "affirm", "soft", [0.9], "llm-judge");
    await expect(runVerifierBattery<Cand>("q", c, [judge], freshOpts())).rejects.toThrow(
      /non-llm-judge/,
    );
  });

  it("rejects a voteThreshold outside [0,1]", async () => {
    await expect(
      runVerifierBattery<Cand>("q", c, [ok()], freshOpts({ voteThreshold: 1.5 })),
    ).rejects.toThrow(/voteThreshold must be in/);
  });

  it("throws BatteryGovernanceError (typed)", async () => {
    await expect(
      runVerifierBattery<Cand>("q", c, [ok()], freshOpts({ adrEco: "" })),
    ).rejects.toBeInstanceOf(BatteryGovernanceError);
  });
});

// ─── Completeness invariant ──────────────────────────────────────────────────

describe("runVerifierBattery ; completeness (reject-as-proof)", () => {
  it("every candidate appears exactly once across accepted ⊎ rejected", async () => {
    const c = cands(4);
    const v = lens("affirm", "affirm", "soft", [0.4, 0.9, 0.6, 0.7]);
    const r = lens("refute", "refute", "hard", [0.1, 0.95, 0.1, 0.1]);

    const d = await runVerifierBattery<Cand>("q", c, [v, r], freshOpts());

    expect(d.verdicts).toHaveLength(4);
    const seen = new Set<number>();
    if (d.acceptedIndex !== null) seen.add(d.acceptedIndex);
    for (const rej of d.rejected) seen.add(rej.candidateIndex);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(d.rejected).toHaveLength(d.acceptedIndex === null ? 4 : 3);
    // C1 killed by the hard refuter; C3 wins among survivors (0.7 * 0.9 = 0.63).
    expect(d.acceptedIndex).toBe(3);
  });
});

// ─── Determinism + replay (rootHash) ─────────────────────────────────────────

describe("runVerifierBattery ; determinism + replay", () => {
  const c = cands(3);
  const lenses = [
    lens("affirm", "affirm", "soft", [0.4, 0.9, 0.6]),
    lens("refute", "refute", "soft", [0.2, 0.1, 0.3]),
  ];

  async function assembleSingleStepTrace(
    auditStep: Awaited<ReturnType<typeof runVerifierBattery<Cand>>>["auditStep"],
    runId: string,
  ): Promise<{ trace: Trace; rootHash: string }> {
    const base = { ...auditStep, index: 0, prevStepHash: GENESIS_PREV_HASH };
    const stepHash = await sha256(canonicalize({ ...base, runId }));
    const step: TraceStep = { ...base, stepHash };
    const config = {};
    const configHash = await sha256(canonicalize(config));
    const trace: Trace = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId,
      agentId: "verifier-battery-test",
      agentVersion: "1.0.0",
      startedAt: auditStep.timestamp,
      completedAt: auditStep.timestamp + auditStep.durationMs,
      status: "completed",
      steps: [step],
      totalSteps: 1,
      rootHash: "",
      config,
      configHash,
    };
    const chain = await buildChain(trace);
    return {
      trace: { ...trace, rootHash: chain.rootHash },
      rootHash: chain.rootHash,
    };
  }

  it("identical inputs + identical recorded clock ⇒ byte-identical decision", async () => {
    const a = await runVerifierBattery<Cand>("q", c, lenses, freshOpts());
    const b = await runVerifierBattery<Cand>("q", c, lenses, freshOpts());

    expect(a.auditStep).toEqual(b.auditStep);
    expect(a.auditStep.outputHash).toBe(b.auditStep.outputHash);
    expect(a.acceptedHash).toBe(b.acceptedHash);
    expect(a.verdicts).toEqual(b.verdicts);
    expect(a.rejected).toEqual(b.rejected);
  });

  it("the audit step folds into a stable, verifiable rootHash", async () => {
    const a = await runVerifierBattery<Cand>("q", c, lenses, freshOpts());
    const b = await runVerifierBattery<Cand>("q", c, lenses, freshOpts());

    const ta = await assembleSingleStepTrace(a.auditStep, "battery-run-001");
    const tb = await assembleSingleStepTrace(b.auditStep, "battery-run-001");

    expect(ta.rootHash).toBe(tb.rootHash);
    expect(ta.rootHash).toMatch(HEX64);

    const chain = await buildChain(ta.trace);
    const verdict = await verifyChain(ta.trace, chain);
    expect(verdict.valid).toBe(true);
  });
});
