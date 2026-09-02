/**
 * Integration: narrator agent with Brain failure injection (Sprint-477).
 *
 * Validates that an agent run:
 *   1. Completes without crashing when Brain emits rate-limit errors.
 *   2. Records Brain-dependent steps as skipped when Brain is degraded.
 *   3. Still records an outcome even with Brain degraded.
 *
 * Uses injectBrainFailure from @vauban-org/agent-sdk/testing/chaos.
 */

import { describe, expect, it, vi } from "vitest";
import { BrainRateLimit, circuitBreaker } from "../../src/index.js";
import type { BrainEntry, BrainEntryInput, BrainPort } from "../../src/ports/index.js";
import type { AgentRunRef, OutcomePort } from "../../src/ports/outcome.js";
import { injectBrainFailure, networkJitter } from "../../src/testing/index.js";

// ─── Minimal in-memory BrainPort ─────────────────────────────────────────

function buildMemoryBrain(): BrainPort & { entries: BrainEntry[] } {
  const entries: BrainEntry[] = [];
  return {
    entries,
    async archiveKnowledge(e: BrainEntryInput): Promise<BrainEntry> {
      const entry: BrainEntry = { id: `entry-${entries.length}`, content: e.content };
      entries.push(entry);
      return entry;
    },
    async queryKnowledge(_q: string): Promise<BrainEntry[]> {
      return [...entries];
    },
  };
}

// ─── Minimal narrator-style agent ────────────────────────────────────────

interface NarratorResult {
  status: "done" | "degraded";
  stepsCompleted: number;
  stepsSkipped: number;
  outcomeRecorded: boolean;
  brainEntriesArchived: number;
}

/**
 * Simplified narrator run: tries to archive a digest to Brain at each step.
 * Falls back gracefully when Brain fails.
 */
async function runNarratorWithBrain(
  brain: BrainPort,
  outcome: OutcomePort,
): Promise<NarratorResult> {
  const steps = ["market-summary", "risk-digest", "daily-narrative"];
  let stepsCompleted = 0;
  let stepsSkipped = 0;
  let brainEntriesArchived = 0;

  for (const step of steps) {
    try {
      const result = await brain.archiveKnowledge({
        content: `${step}: step output`,
        category: "narrator",
        tags: ["narrator", step],
      });
      if (result !== null) {
        brainEntriesArchived += 1;
        stepsCompleted += 1;
      } else {
        stepsSkipped += 1;
      }
    } catch (_err) {
      // Brain degraded — skip step, do NOT crash.
      stepsSkipped += 1;
    }
  }

  // Always record the outcome, regardless of Brain health.
  outcome.recordOutcomeAsync({
    id: "run-001",
    agent_id: "narrator",
    run_id: "test-run",
  });

  return {
    status: stepsSkipped > 0 ? "degraded" : "done",
    stepsCompleted,
    stepsSkipped,
    outcomeRecorded: true,
    brainEntriesArchived,
  };
}

// ─── Outcome mock ────────────────────────────────────────────────────────

function buildOutcomeMock(): OutcomePort & { calls: AgentRunRef[] } {
  const calls: AgentRunRef[] = [];
  return {
    calls,
    recordOutcomeAsync(run: AgentRunRef): void {
      calls.push(run);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("narrator-chaos: injectBrainFailure (rate-limit)", () => {
  it("run completes without crash; Brain-dependent steps skipped on failure", async () => {
    const brain = buildMemoryBrain();
    const outcome = buildOutcomeMock();

    // Deterministic: first call fails, second succeeds, third fails
    let i = 0;
    const schedule = [0.1, 0.9, 0.1]; // 0.1 < 0.3 → fail; 0.9 >= 0.3 → pass
    const flaky = injectBrainFailure(brain, {
      failureRate: 0.3,
      type: "rate-limit",
      random: () => schedule[i++ % schedule.length],
    });

    const result = await runNarratorWithBrain(flaky, outcome);

    // Must complete without throw.
    expect(result.status).toBe("degraded");
    // At least one step succeeded (r=0.9 at index 1).
    expect(result.stepsCompleted).toBeGreaterThanOrEqual(1);
    // At least one step was skipped (r=0.1 < 0.3).
    expect(result.stepsSkipped).toBeGreaterThanOrEqual(1);
    // Steps completed + skipped = total steps.
    expect(result.stepsCompleted + result.stepsSkipped).toBe(3);
  });

  it("outcome is recorded even with Brain fully degraded", async () => {
    const brain = buildMemoryBrain();
    const outcome = buildOutcomeMock();

    // fullOutage: all calls fail.
    const dead = injectBrainFailure(brain, { failureRate: 1.0, type: "unavailable" });

    const result = await runNarratorWithBrain(dead, outcome);

    expect(result.outcomeRecorded).toBe(true);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0].agent_id).toBe("narrator");
    // All 3 steps skipped — Brain fully down.
    expect(result.stepsSkipped).toBe(3);
    expect(result.brainEntriesArchived).toBe(0);
  });

  it("narrator with p99Ms jitter completes within reasonable wall time", async () => {
    const brain = buildMemoryBrain();
    const outcome = buildOutcomeMock();

    // p99Ms=50 → p50 defaults to 5ms; test should complete in < 300ms.
    const slow = networkJitter(brain, { p99Ms: 50, p50Ms: 5 });

    const start = Date.now();
    const result = await runNarratorWithBrain(slow, outcome);
    const elapsed = Date.now() - start;

    // All steps succeed (no failure injection).
    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsSkipped).toBe(0);
    // Wall time bounded — p99=50ms * 3 steps = 150ms; allow 3× headroom.
    expect(elapsed).toBeLessThan(600);
  });

  it("circuit-breaker over flaky Brain short-circuits after threshold", async () => {
    const brain = buildMemoryBrain();
    // Force all calls to fail.
    const dead = injectBrainFailure(brain, { failureRate: 1.0, type: "rate-limit" });

    const cb = circuitBreaker(dead.archiveKnowledge.bind(dead), {
      name: "narrator.brain",
      failureThreshold: 2,
      resetAfterMs: 10_000,
    });

    // First 2 calls fail (BrainRateLimit) — trips the breaker.
    await expect(cb({ content: "a" })).rejects.toBeInstanceOf(BrainRateLimit);
    await expect(cb({ content: "b" })).rejects.toBeInstanceOf(BrainRateLimit);

    expect(cb.state).toBe("open");

    // Subsequent calls are fast-failed by the breaker (no upstream call).
    const calls = vi.spyOn(dead, "archiveKnowledge");
    await expect(cb({ content: "c" })).rejects.toThrow("fast-fail");
    // Upstream was NOT invoked — breaker is protecting the port.
    expect(calls).not.toHaveBeenCalled();
  });
});
