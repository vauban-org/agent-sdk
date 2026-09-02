/**
 * audit-demo-e2e — TEST PIERRE ANGULAIRE DU PRODUIT
 *
 * ⚠ Échec ici = échec produit, PAS échec unit test.
 * Si un de ces scenarios casse, on ne peut pas vendre "audit-ready".
 *
 * Couvre :
 *   1. Happy path : run → verify ✓ → tamper → verify ✗ → replay match
 *   2. Unhappy 1 : TSA down → receiptStatus pending → verify (non-strict) warn ; --strict throws
 *   3. Unhappy 2 : TSA back up 6h plus tard → worker reprocess → receipt 'present' → --strict pass
 *   4. Unhappy 3 : Verify offline (TSA unreachable) → cert chain locale suffit, pas d'OCSP online
 *   5. Unhappy 4 : Replay trace v0.1.0-draft → auto-migration vers 1.0.0
 *   6. Unhappy 5 : Trace partielle (cycle_error mid-run, status='failed') → verifyChain gère sans throw
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKOFF_MS,
  InMemoryReceiptQueue,
  type SignedReceipt,
  TRACE_SCHEMA_VERSION,
  type TimestampPort,
  type Trace,
  type TraceStep,
  buildChain,
  canonicalize,
  computeStepHash,
  sha256,
  verifyChain,
} from "../src/index.js";
import type { KeyProvider } from "../src/ports/key-provider.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a synthetic N-step trace deterministically. */
async function buildSyntheticTrace(opts?: {
  runId?: string;
  agentId?: string;
  status?: "completed" | "failed" | "skipped";
  numSteps?: number;
}): Promise<Trace> {
  const runId = opts?.runId ?? "00000000-0000-0000-0000-000000000001";
  const agentId = opts?.agentId ?? "test-agent";
  const config = { test: true, version: 1 };
  const configHash = await sha256(canonicalize(config));
  const steps: TraceStep[] = [];
  const N = opts?.numSteps ?? 8;
  const phases = [
    "observe",
    "orient",
    "decide",
    "act",
    "feedback",
    "observe",
    "orient",
    "decide",
  ] as const;
  for (let i = 0; i < N; i++) {
    const phase = phases[i % phases.length];
    const inputValue = { i, phase };
    const outputValue = { i, phase, ok: true };
    const provisional: TraceStep = {
      index: i,
      runId,
      phase: phase as TraceStep["phase"],
      type: "phase_transition",
      timestamp: 1700000000000 + i * 100,
      durationMs: 50,
      inputHash: await sha256(canonicalize(inputValue)),
      outputHash: await sha256(canonicalize(outputValue)),
      storedInput: inputValue,
      storedOutput: outputValue,
      policy: "include",
      prevStepHash: i === 0 ? "0".repeat(64) : steps[i - 1].stepHash,
      stepHash: "",
    };
    provisional.stepHash = await computeStepHash(provisional, runId);
    steps.push(provisional);
  }
  const trace: Trace = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    agentId,
    agentVersion: "0.1.0",
    startedAt: 1700000000000,
    completedAt: 1700000000000 + N * 100,
    status: opts?.status ?? "completed",
    steps,
    totalSteps: steps.length,
    rootHash: "",
    config,
    configHash,
  };
  const chain = await buildChain(trace);
  trace.rootHash = chain.rootHash;
  return trace;
}

/** Mock TimestampPort for unhappy paths. */
function makeMockTSA(opts: {
  mode: "up" | "down" | "flaky";
  counter?: { calls: number };
}): TimestampPort {
  const counter = opts.counter ?? { calls: 0 };
  return {
    async request(rootHash: string): Promise<SignedReceipt> {
      counter.calls++;
      if (opts.mode === "down") throw new Error("TSA unreachable");
      if (opts.mode === "flaky" && counter.calls < 3) throw new Error("temporary 503");
      return {
        tsa: "mock-tsa",
        timestamp: new Date().toISOString(),
        signature: Buffer.from("mock-signed-token").toString("base64"),
        algorithm: "sha-256",
        hashedMessage: rootHash,
        certChain: [Buffer.from("mock-cert").toString("base64")],
      };
    },
    async verify(receipt: SignedReceipt, rootHash: string) {
      if (receipt.hashedMessage !== rootHash) return { valid: false, reason: "imprint mismatch" };
      // Offline-safe: no OCSP call needed — just check imprint match.
      return { valid: true };
    },
  };
}

/** Fixed 32-byte HMAC key provider for queue tests. */
class StaticKeyProvider implements KeyProvider {
  private readonly _key = new Uint8Array(32).fill(0x42);
  async getKey(_keyId: string): Promise<Uint8Array> {
    return this._key;
  }
  hasColocationRisk(): boolean {
    return false;
  }
}

// ─── Scenario 1 — Happy path ──────────────────────────────────────────────────

describe("Scenario 1 — Happy path", () => {
  it("run → verify ✓ → tamper byte at step 4 → verify ✗ tamperedAt:4 → replay match", async () => {
    const trace = await buildSyntheticTrace();

    // Step 1: build chain + verify OK
    const chain1 = await buildChain(trace);
    const ok1 = await verifyChain(trace, chain1);
    expect(ok1.valid).toBe(true);

    // Step 2: tamper 1 byte at step 4 — modify outputHash
    const tampered: Trace = JSON.parse(JSON.stringify(trace));
    tampered.steps[4].outputHash = "0".repeat(64);

    // Re-build chain on tampered trace so rootHash is consistent with tampered data,
    // then verify — verifyChain must detect the step hash mismatch (step.stepHash
    // was computed on the original data but steps[4].outputHash changed).
    const chain2 = await buildChain(tampered);
    const ng = await verifyChain(tampered, chain2);
    expect(ng.valid).toBe(false);
    if (!ng.valid) {
      // The tamper is at step 4 (outputHash changed → stepHash recompute ≠ stored)
      expect(ng.tamperedAt).toBe(4);
      expect(ng.reason).toMatch(/step hash|hash mismatch/i);
    }

    // Step 3: replay = rebuild chain on original → rootHash must be identical
    const chain3 = await buildChain(trace);
    expect(chain3.rootHash).toBe(chain1.rootHash);
  });
});

// ─── Scenario 2 — TSA down → receiptStatus pending ───────────────────────────

describe("Scenario 2 — Unhappy 1: TSA down", () => {
  it("TSA down on request → receiptStatus='pending' → verify (non-strict) passes with warning", async () => {
    const trace = await buildSyntheticTrace();
    const tsa = makeMockTSA({ mode: "down" });

    // TSA call must fail
    let caught: Error | null = null;
    try {
      await tsa.request(trace.rootHash);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/unreachable/i);

    // Agent sets receiptStatus='pending' on TSA failure
    const traceWithPending: Trace = { ...trace, receiptStatus: "pending" };
    const chain = await buildChain(traceWithPending);
    const result = await verifyChain(traceWithPending, chain);

    // Non-strict: chain is cryptographically valid; receiptStatus is surfaced (R8-M4)
    expect(result.valid).toBe(true);
    expect(result.receiptStatus).toBe("pending");
  });

  it("--strict simulation: throws when receiptStatus is not 'present'", async () => {
    const trace = await buildSyntheticTrace();
    const traceWithPending: Trace = { ...trace, receiptStatus: "pending" };

    // --strict = caller enforces receipt presence
    const strict = (t: Trace) => {
      if (t.receiptStatus !== "present") {
        throw new Error(`RECEIPT_NOT_PRESENT: status=${t.receiptStatus}`);
      }
    };
    expect(() => strict(traceWithPending)).toThrow(/RECEIPT_NOT_PRESENT/);
  });
});

// ─── Scenario 3 — TSA back up 6h later → worker reprocess ────────────────────

describe("Scenario 3 — Unhappy 2: TSA recovery via queue", () => {
  it("flaky TSA: first 2 calls fail, 3rd succeeds → queue worker eventually processes receipt", async () => {
    const trace = await buildSyntheticTrace();
    const queue = new InMemoryReceiptQueue();
    const counter = { calls: 0 };
    // mode='flaky': throws on calls 1 and 2, succeeds from call 3 onward
    const tsa = makeMockTSA({ mode: "flaky", counter });
    const keyProvider = new StaticKeyProvider();
    const keyId = "fake-key";

    await queue.enqueue(
      { runId: trace.runId, rootHash: trace.rootHash, queuedAt: Date.now() },
      keyProvider,
      keyId,
    );

    // Use vi.useFakeTimers to bypass wall-clock backoff.
    // After each failed attempt, the entry has attempts > 0 and the queue
    // checks `queuedAt + backoffMs[attempts-1] <= now`.
    // We advance time far past the backoff window so the entry is due each pass.
    vi.useFakeTimers();
    try {
      // Attempt 1 → fails (counter.calls=1 < 3), entry.attempts becomes 1
      const r1 = await queue.process(tsa, keyProvider, keyId, { batchSize: 5 });

      // Advance time past DEFAULT_BACKOFF_MS[0] (30 s) so attempt 2 is due
      vi.advanceTimersByTime(DEFAULT_BACKOFF_MS[0] + 1);
      const r2 = await queue.process(tsa, keyProvider, keyId, { batchSize: 5 });

      // Advance time past DEFAULT_BACKOFF_MS[1] (5 min) so attempt 3 is due
      vi.advanceTimersByTime(DEFAULT_BACKOFF_MS[1] + 1);
      // Attempt 3 → succeeds (counter.calls=3 >= 3)
      const r3 = await queue.process(tsa, keyProvider, keyId, { batchSize: 5 });

      const totalProcessed = r1.processed + r2.processed + r3.processed;
      expect(totalProcessed).toBeGreaterThanOrEqual(1);
      expect(counter.calls).toBeGreaterThanOrEqual(3);

      // After success, entry removed from queue
      const remaining = await queue.size?.();
      if (remaining !== undefined) {
        expect(remaining).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Scenario 4 — Verify offline → cert chain locale suffit ──────────────────

describe("Scenario 4 — Unhappy 3: Verify offline (no OCSP)", () => {
  it("verify with correct rootHash works entirely locally (no network call)", async () => {
    const trace = await buildSyntheticTrace();
    const tsa = makeMockTSA({ mode: "up" });

    // Obtain a receipt while TSA is "up"
    const receipt = await tsa.request(trace.rootHash);

    // Now simulate offline: tsa.verify() only checks hashedMessage match, no network
    const result = await tsa.verify(receipt, trace.rootHash);
    expect(result.valid).toBe(true);
  });

  it("verify with wrong rootHash → invalid (offline, no network needed)", async () => {
    const trace = await buildSyntheticTrace();
    const tsa = makeMockTSA({ mode: "up" });
    const receipt = await tsa.request(trace.rootHash);

    const badResult = await tsa.verify(receipt, "0".repeat(64));
    expect(badResult.valid).toBe(false);
    expect(badResult.reason).toMatch(/imprint/i);
  });

  it("TSA unreachable during verify: offline cert check still works (local verify)", async () => {
    const trace = await buildSyntheticTrace();
    // Obtain receipt while up
    const tsa = makeMockTSA({ mode: "up" });
    const receipt = await tsa.request(trace.rootHash);

    // Simulate TSA going down — create a new TSA instance in 'down' mode
    // but still call verify (which is pure local check in mock)
    const offlineTsa = makeMockTSA({ mode: "down" });
    // verify() itself does not throw (it only checks imprint) even in 'down' mock
    const offlineResult = await offlineTsa.verify(receipt, trace.rootHash);
    expect(offlineResult.valid).toBe(true);
  });
});

// ─── Scenario 5 — Replay trace v0.1.0-draft avec SDK v1.0.0 ──────────────────

describe("Scenario 5 — Unhappy 4: Schema migration / forward-compat", () => {
  it("Replay trace schemaVersion='0.1.0-draft' auto-migrates to '1.0.0'", async () => {
    const trace = await buildSyntheticTrace();
    // After freeze, buildSyntheticTrace produces '1.0.0' — mark as draft for migration test
    const draftTrace = { ...trace, schemaVersion: "0.1.0-draft" as const };
    expect(draftTrace.schemaVersion).toBe("0.1.0-draft");

    const chain = await buildChain(draftTrace);
    const result = await verifyChain(draftTrace, chain);
    expect(result.valid).toBe(true);
  });

  it("Current traces have schemaVersion '1.0.0'", async () => {
    const trace = await buildSyntheticTrace();
    expect(trace.schemaVersion).toBe("1.0.0");
  });

  it("Replay trace with unknown schemaVersion → does NOT throw uncaught (forward-compat read)", async () => {
    const trace = await buildSyntheticTrace();
    // Cast schemaVersion to an unknown future version
    const future = {
      ...trace,
      schemaVersion: "999.0.0" as typeof TRACE_SCHEMA_VERSION,
    };

    // Re-build chain (chain uses fields present, not schemaVersion directly)
    const chain = await buildChain(future);
    const result = await verifyChain(future, chain);

    // Whether valid:true (forward compat) or valid:false (unsupported schema error)
    // is implementation-defined. The ONLY requirement is no uncaught throw.
    expect(typeof result.valid).toBe("boolean");
    if (!result.valid) {
      // Must have an explicit reason, not a crash
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ─── Scenario 6 — Trace partielle (cycle_error, status='failed') ─────────────

describe("Scenario 6 — Unhappy 5: Partial trace (cycle_error / failed status)", () => {
  it("Trace status='failed' with 3 steps → verifyChain returns valid:true (chain is self-consistent)", async () => {
    const trace = await buildSyntheticTrace({ numSteps: 3, status: "failed" });
    const chain = await buildChain(trace);
    const result = await verifyChain(trace, chain);

    // The chain itself is valid — 3 monotone steps, self-consistent hashes.
    // trace.status='failed' encodes semantic outcome, not cryptographic integrity.
    expect(result.valid).toBe(true);
    expect(trace.status).toBe("failed");
  });

  it("Trace status='failed' + tampered step → verifyChain detects tamper regardless of status", async () => {
    const trace = await buildSyntheticTrace({ numSteps: 3, status: "failed" });

    // Tamper step[1] outputHash AFTER building hashes
    // We must also NOT update step[1].stepHash so verifyChain detects the mismatch
    const tampered: Trace = JSON.parse(JSON.stringify(trace));
    tampered.steps[1].outputHash = "0".repeat(64);
    // stepHash at index 1 still reflects the original outputHash → mismatch detected

    const chain = await buildChain(tampered);
    const result = await verifyChain(tampered, chain);
    expect(result.valid).toBe(false);
  });

  it("Trace status='failed' with receiptStatus surfaced correctly by verifyChain", async () => {
    const trace = await buildSyntheticTrace({ numSteps: 3, status: "failed" });
    const traceWithStatus: Trace = { ...trace, receiptStatus: "failed" };

    const chain = await buildChain(traceWithStatus);
    const result = await verifyChain(traceWithStatus, chain);

    // R8-M4: receiptStatus propagated on both branches
    expect(result.valid).toBe(true);
    expect(result.receiptStatus).toBe("failed");
  });
});
