/**
 * Tests for proof/chain — buildChain, verifyChain (7 checks), CH9, AR6, R8-M4.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, buildChain, computeStepHash, verifyChain } from "../src/proof/chain.js";
import { sha256 } from "../src/proof/sha256.js";
import { canonicalize } from "../src/trace/canonical.js";
import type { Trace, TraceStep } from "../src/trace/schema.js";
import { TRACE_SCHEMA_VERSION } from "../src/trace/schema.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function makeStep(
  index: number,
  runId: string,
  prevStepHash: string,
  overrides?: Partial<TraceStep>,
): Promise<TraceStep> {
  const base: Omit<TraceStep, "stepHash"> = {
    index,
    runId,
    phase: "decide",
    type: "llm_call",
    timestamp: 1_700_000_000_000 + index * 1000,
    durationMs: 100 + index,
    inputHash: await sha256(`input-${index}`),
    outputHash: await sha256(`output-${index}`),
    policy: "hash-only",
    prevStepHash,
    ...overrides,
  };
  const stepHash = await sha256(canonicalize({ ...base, runId }));
  return { ...base, stepHash };
}

async function makeTrace(
  stepCount: number,
  overrides?: Partial<Trace>,
): Promise<{ trace: Trace; hashes: string[] }> {
  const runId = "test-run-id-fixture-001";
  const agentId = "test-agent";
  const agentVersion = "1.0.0";
  const config = { model: "gpt-4o", temperature: 0 };
  const configHash = await sha256(canonicalize(config));

  const steps: TraceStep[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < stepCount; i++) {
    const prevHash = i === 0 ? GENESIS_PREV_HASH : hashes[i - 1];
    const step = await makeStep(i, runId, prevHash);
    steps.push(step);
    hashes.push(step.stepHash);
  }

  const trace: Trace = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    agentId,
    agentVersion,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_000 + stepCount * 1000,
    status: "completed",
    steps,
    totalSteps: steps.length,
    rootHash: "", // placeholder — overridden by buildChain
    config,
    configHash,
    ...overrides,
  };

  return { trace, hashes };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("proof/chain", () => {
  let trace5: Trace;
  let hashes5: string[];

  beforeAll(async () => {
    const result = await makeTrace(5);
    trace5 = result.trace;
    hashes5 = result.hashes;
    // Set rootHash via buildChain so the fixture is consistent.
    const chain = await buildChain(trace5);
    trace5 = { ...trace5, rootHash: chain.rootHash };
  });

  // ── buildChain ──────────────────────────────────────────────────────────────

  describe("buildChain", () => {
    it("returns algorithm sha-256 and correct entry count", async () => {
      const chain = await buildChain(trace5);
      expect(chain.algorithm).toBe("sha-256");
      expect(chain.entries).toHaveLength(5);
    });

    it("entries have correct indices", async () => {
      const chain = await buildChain(trace5);
      for (let i = 0; i < 5; i++) {
        expect(chain.entries[i].index).toBe(i);
      }
    });

    it("entry stepHashes match computeStepHash for each step", async () => {
      const chain = await buildChain(trace5);
      for (let i = 0; i < 5; i++) {
        const expected = await computeStepHash(trace5.steps[i], trace5.runId);
        expect(chain.entries[i].stepHash).toBe(expected);
      }
    });

    it("throws when trace has no steps", async () => {
      const { trace } = await makeTrace(0);
      await expect(buildChain({ ...trace, steps: [], totalSteps: 0 })).rejects.toThrow(
        "at least one step",
      );
    });
  });

  // ── verifyChain — happy path ────────────────────────────────────────────────

  describe("verifyChain — happy path", () => {
    it("valid trace → { valid: true }", async () => {
      const chain = await buildChain(trace5);
      const result = await verifyChain(trace5, chain);
      expect(result.valid).toBe(true);
    });

    it("receiptStatus propagated when present (valid branch)", async () => {
      const chain = await buildChain(trace5);
      const traceWithReceipt = { ...trace5, receiptStatus: "present" as const };
      const result = await verifyChain(traceWithReceipt, chain);
      expect(result.valid).toBe(true);
      expect((result as { valid: true; receiptStatus?: string }).receiptStatus).toBe("present");
    });

    it("receiptStatus absent when not present", async () => {
      const chain = await buildChain(trace5);
      const result = await verifyChain(trace5, chain);
      expect("receiptStatus" in result).toBe(false);
    });
  });

  // ── Check 4 — step hash mismatch ────────────────────────────────────────────

  describe("Check 4 — step hash mismatch", () => {
    it("tampered stepHash → valid: false, tamperedAt: 2, reason: 'step hash mismatch'", async () => {
      const chain = await buildChain(trace5);
      const tamperedSteps = [...trace5.steps];
      tamperedSteps[2] = { ...tamperedSteps[2], stepHash: "0".repeat(64) };
      const tamperedTrace = { ...trace5, steps: tamperedSteps };

      const result = await verifyChain(tamperedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.tamperedAt).toBe(2);
        expect(result.reason).toBe("step hash mismatch");
      }
    });
  });

  // ── Check 2 — anti-truncation ───────────────────────────────────────────────

  describe("Check 2 — anti-truncation", () => {
    it("truncated tail → valid: false, reason: 'totalSteps mismatch'", async () => {
      const chain = await buildChain(trace5);
      const truncatedSteps = trace5.steps.slice(0, 4);
      const truncatedTrace = { ...trace5, steps: truncatedSteps };
      // totalSteps still = 5 but steps.length = 4

      const result = await verifyChain(truncatedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("totalSteps mismatch");
      }
    });
  });

  // ── Check 3 — AR6 runId anti-splice ─────────────────────────────────────────

  describe("Check 3 — AR6 runId anti-splice", () => {
    it("wrong runId on step 3 → valid: false, tamperedAt: 3, reason: 'runId mismatch'", async () => {
      const chain = await buildChain(trace5);
      const tamperedSteps = [...trace5.steps];
      tamperedSteps[3] = { ...tamperedSteps[3], runId: "other-run-id" };
      const tamperedTrace = { ...trace5, steps: tamperedSteps };

      const result = await verifyChain(tamperedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.tamperedAt).toBe(3);
        expect(result.reason).toBe("runId mismatch");
      }
    });
  });

  // ── Check 1 — monotone index ─────────────────────────────────────────────────

  describe("Check 1 — monotone index", () => {
    it("index gap → valid: false, tamperedAt: 2, reason: 'monotone violation'", async () => {
      const chain = await buildChain(trace5);
      const tamperedSteps = [...trace5.steps];
      tamperedSteps[2] = { ...tamperedSteps[2], index: 5 };
      const tamperedTrace = { ...trace5, steps: tamperedSteps };

      const result = await verifyChain(tamperedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.tamperedAt).toBe(2);
        expect(result.reason).toBe("monotone violation");
      }
    });
  });

  // ── Check 5 — prev hash chain ───────────────────────────────────────────────

  describe("Check 5 — prev hash chain linkage", () => {
    it("broken prevStepHash (with matching stepHash recomputed) → valid: false, tamperedAt: 2, reason: 'prev hash mismatch'", async () => {
      // To isolate check 5 from check 4, we tamper prevStepHash AND recompute
      // stepHash consistently (so the step is self-consistent but breaks the chain).
      const chain = await buildChain(trace5);
      const tamperedSteps = [...trace5.steps];
      const fakePrev = "f".repeat(64);
      // Build a step that is internally consistent (stepHash matches its own data)
      // but has a wrong prevStepHash relative to the chain.
      const tamperedStep2 = { ...tamperedSteps[2], prevStepHash: fakePrev };
      const newStepHash = await computeStepHash(tamperedStep2, trace5.runId);
      tamperedSteps[2] = { ...tamperedStep2, stepHash: newStepHash };
      const tamperedTrace = { ...trace5, steps: tamperedSteps };

      const result = await verifyChain(tamperedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.tamperedAt).toBe(2);
        expect(result.reason).toBe("prev hash mismatch");
      }
    });
  });

  // ── Check 6 — root hash ─────────────────────────────────────────────────────

  describe("Check 6 — root hash", () => {
    it("tampered chain.rootHash → valid: false, reason: 'root hash mismatch'", async () => {
      const chain = await buildChain(trace5);
      const tamperedChain = { ...chain, rootHash: "a".repeat(64) };

      const result = await verifyChain(trace5, tamperedChain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("root hash mismatch");
      }
    });
  });

  // ── Check 7 — CH9 config hash ───────────────────────────────────────────────

  describe("Check 7 — CH9 config anti-swap", () => {
    it("modified config without updating configHash → valid: false, reason: 'config hash mismatch'", async () => {
      const chain = await buildChain(trace5);
      const swappedTrace = { ...trace5, config: { model: "evil-model" } };
      // configHash still matches original config

      const result = await verifyChain(swappedTrace, chain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("config hash mismatch");
      }
    });

    it("modified config WITH recalculated configHash → valid: true (CH9 is bound)", async () => {
      const newConfig = { model: "legit-replacement", temperature: 0.5 };
      const newConfigHash = await sha256(canonicalize(newConfig));

      // Need to rebuild steps with the same runId but different config context.
      // Config swap detection is independent of step content — only configHash matters.
      const rebuiltTrace = {
        ...trace5,
        config: newConfig,
        configHash: newConfigHash,
      };

      // Must also rebuild chain for the new configHash.
      const rebuiltChain = await buildChain(rebuiltTrace);
      const rebuiltTraceWithRoot = {
        ...rebuiltTrace,
        rootHash: rebuiltChain.rootHash,
      };

      const result = await verifyChain(rebuiltTraceWithRoot, rebuiltChain);
      expect(result.valid).toBe(true);
    });
  });

  // ── R8-M4 — receiptStatus on invalid branch ──────────────────────────────────

  describe("R8-M4 — receiptStatus on failure branch", () => {
    it("valid: false result includes receiptStatus when present on trace", async () => {
      const chain = await buildChain(trace5);
      const tamperedChain = { ...chain, rootHash: "b".repeat(64) };
      const traceWithReceipt = { ...trace5, receiptStatus: "pending" as const };

      const result = await verifyChain(traceWithReceipt, tamperedChain);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.receiptStatus).toBe("pending");
      }
    });

    it("valid: false result has no receiptStatus when absent from trace", async () => {
      const chain = await buildChain(trace5);
      const tamperedChain = { ...chain, rootHash: "c".repeat(64) };

      const result = await verifyChain(trace5, tamperedChain);
      expect(result.valid).toBe(false);
      expect("receiptStatus" in result).toBe(false);
    });

    it("receiptStatus 'failed' propagated on valid branch", async () => {
      const chain = await buildChain(trace5);
      const traceWithFailed = { ...trace5, receiptStatus: "failed" as const };
      const result = await verifyChain(traceWithFailed, chain);
      expect(result.valid).toBe(true);
      expect((result as { valid: true; receiptStatus?: string }).receiptStatus).toBe("failed");
    });
  });

  // ── GENESIS_PREV_HASH constant ────────────────────────────────────────────────

  describe("GENESIS_PREV_HASH", () => {
    it("is a 64-character hex string of all zeros", () => {
      expect(GENESIS_PREV_HASH).toHaveLength(64);
      expect(GENESIS_PREV_HASH).toMatch(/^0{64}$/);
    });
  });

  // ── buildChain structural guarantees ─────────────────────────────────────────

  describe("buildChain — structural guarantees", () => {
    it("rootHash is a 64-character lowercase hex string", async () => {
      const chain = await buildChain(trace5);
      expect(chain.rootHash).toHaveLength(64);
      expect(chain.rootHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic — same trace produces the same rootHash", async () => {
      const chain1 = await buildChain(trace5);
      const chain2 = await buildChain(trace5);
      expect(chain1.rootHash).toBe(chain2.rootHash);
    });
  });

  // ── single-step trace ─────────────────────────────────────────────────────────

  describe("single-step trace", () => {
    it("passes verifyChain", async () => {
      const { trace } = await makeTrace(1);
      const chain = await buildChain(trace);
      const result = await verifyChain(trace, chain);
      expect(result.valid).toBe(true);
    });

    it("first entry prevStepHash in step equals GENESIS_PREV_HASH", async () => {
      const { trace } = await makeTrace(1);
      expect(trace.steps[0].prevStepHash).toBe(GENESIS_PREV_HASH);
    });
  });
});
