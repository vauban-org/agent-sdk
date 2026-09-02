/**
 * tests/constitution-signal.test.ts
 *
 * Unit tests for publishSignal and publishAllSignals.
 * Uses an InMemoryEpisodicMemory mock to assert Brain episodic call shape.
 */

import { describe, expect, it, vi } from "vitest";
import {
  publishAllSignals,
  publishEpisodicEvent,
  publishSignal,
} from "../src/constitution/signal.js";
import type { SignalBrainPort } from "../src/constitution/signal.js";
import type { CycleSnapshot } from "../src/constitution/types.js";
import { InMemoryEpisodicMemory } from "../src/ports/brain.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    runId: "run-signal-test",
    steps: [],
    budgetUsdMax: 1.0,
    budgetUsdSpent: 0.05,
    scope_id: "scope-test",
    rootHash: "b".repeat(64),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// publishSignal
// ---------------------------------------------------------------------------

describe("publishSignal", () => {
  it("records an episodic entry via BrainPort.episodic", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };

    await publishSignal(brainPort, makeCycle(), "Robuste", 0.85, "all checks passed");

    const entries = await episodic.since("constitution:Robuste", 0);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.event).toBe("constitution_signal");
    expect(entry.runId).toBe("run-signal-test");
    expect(entry.metadata?.axiom).toBe("Robuste");
    expect(entry.metadata?.score).toBe(0.85);
    expect(entry.metadata?.rationale).toBe("all checks passed");
    expect(entry.metadata?.rootHash).toBe("b".repeat(64));
  });

  it("includes parentRunId when present", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };
    const cycle = makeCycle({ parentRunId: "parent-run-xyz" });

    await publishSignal(brainPort, cycle, "SOTA", 0.72, "rationale");

    const entries = await episodic.since("constitution:SOTA", 0);
    expect(entries[0]?.metadata?.parentRunId).toBe("parent-run-xyz");
  });

  it("includes scope_id when present", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };

    await publishSignal(brainPort, makeCycle({ scope_id: "scope-xyz" }), "Profitable", 0.9, "ok");

    const entries = await episodic.since("constitution:Profitable", 0);
    expect(entries[0]?.metadata?.scope_id).toBe("scope-xyz");
  });

  it("tags the entry with ['constitution_signal', axiomId]", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };

    await publishSignal(brainPort, makeCycle(), "AntiFragile", 0.6, "ok");

    const entries = await episodic.since("constitution:AntiFragile", 0);
    const tags = entries[0]?.metadata?.tags as string[];
    expect(tags).toContain("constitution_signal");
    expect(tags).toContain("AntiFragile");
  });

  it("no-ops silently when episodic is absent", async () => {
    const brainPort: SignalBrainPort = {}; // no episodic tier
    await expect(
      publishSignal(brainPort, makeCycle(), "Institutionnel", 0.5, "n/a"),
    ).resolves.toBeUndefined();
  });

  it("calls episodic.record with correct agentId pattern", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const recordSpy = vi.spyOn(episodic, "record");
    const brainPort: SignalBrainPort = { episodic };

    await publishSignal(brainPort, makeCycle(), "Robuste", 0.7, "test");

    expect(recordSpy).toHaveBeenCalledOnce();
    const [agentId, runId, event] = recordSpy.mock.calls[0]!;
    expect(agentId).toBe("constitution:Robuste");
    expect(runId).toBe("run-signal-test");
    expect(event).toBe("constitution_signal");
  });
});

// ---------------------------------------------------------------------------
// publishAllSignals
// ---------------------------------------------------------------------------

describe("publishAllSignals", () => {
  it("publishes one episodic entry per axiom", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };
    const cycle = makeCycle();

    await publishAllSignals(brainPort, cycle, [
      { axiomId: "Institutionnel", score: 0.8, rationale: "ok" },
      { axiomId: "SOTA", score: 0.7, rationale: "ok" },
      { axiomId: "Robuste", score: 0.9, rationale: "ok" },
    ]);

    const instEntries = await episodic.since("constitution:Institutionnel", 0);
    const sotaEntries = await episodic.since("constitution:SOTA", 0);
    const robusteEntries = await episodic.since("constitution:Robuste", 0);

    expect(instEntries).toHaveLength(1);
    expect(sotaEntries).toHaveLength(1);
    expect(robusteEntries).toHaveLength(1);
  });

  it("no-ops silently when episodic is absent", async () => {
    const brainPort: SignalBrainPort = {};
    await expect(
      publishAllSignals(brainPort, makeCycle(), [
        { axiomId: "Profitable", score: 0.5, rationale: "ok" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("throws AggregateError when one publish fails", async () => {
    const episodic = new InMemoryEpisodicMemory();
    vi.spyOn(episodic, "record").mockRejectedValueOnce(new Error("Brain write timeout"));
    const brainPort: SignalBrainPort = { episodic };

    await expect(
      publishAllSignals(brainPort, makeCycle(), [
        { axiomId: "Profitable", score: 0.5, rationale: "ok" },
      ]),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});

// ---------------------------------------------------------------------------
// publishEpisodicEvent — the single episodic-write pattern (sprint-895)
// ---------------------------------------------------------------------------

describe("publishEpisodicEvent", () => {
  it("appends an event via episodic.append and returns the id", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const brainPort: SignalBrainPort = { episodic };

    const id = await publishEpisodicEvent(brainPort, {
      agentId: "agent-x",
      sessionId: "run-1",
      eventType: "decision",
      content: { phase: "decide", digest: "len=3:h=00000001" },
      importanceScore: 0.7,
    });

    expect(id).toBeTypeOf("string");
    const events = await episodic.query({ agentId: "agent-x", sessionId: "run-1" });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("decision");
    expect(events[0]?.importanceScore).toBe(0.7);
  });

  it("no-ops (returns undefined) when the episodic plane is absent", async () => {
    const brainPort: SignalBrainPort = {}; // semantic-only host
    const id = await publishEpisodicEvent(brainPort, {
      agentId: "agent-x",
      sessionId: "run-1",
      eventType: "observation",
      content: "obs",
    });
    expect(id).toBeUndefined();
  });

  it("forwards metadata + traceId to append options", async () => {
    const episodic = new InMemoryEpisodicMemory();
    const appendSpy = vi.spyOn(episodic, "append");
    const brainPort: SignalBrainPort = { episodic };

    await publishEpisodicEvent(brainPort, {
      agentId: "agent-x",
      sessionId: "run-1",
      eventType: "error",
      content: "boom",
      metadata: { errorName: "RangeError" },
      traceId: "trace-42",
    });

    const [, , eventType, , opts] = appendSpy.mock.calls[0]!;
    expect(eventType).toBe("error");
    expect(opts?.metadata).toEqual({ errorName: "RangeError" });
    expect(opts?.traceId).toBe("trace-42");
  });
});
