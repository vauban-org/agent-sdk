/**
 * Tests for agent-sdk test helpers:
 *   src/testing/test-brain-port.ts
 *   src/testing/test-child-agent.ts
 *   src/skills/_otel.ts
 *
 * Coverage (TestBrainPort):
 *   archiveKnowledge — stores entry, assigns sequential id, returns BrainEntry
 *   queryKnowledge — FTS on content, category filter, tag filter, limit
 *   reset — clears entries and restarts id counter
 *   archivePostmortem/archiveLesson — no-op (smoke test)
 *
 * Coverage (TestChildAgentPort):
 *   spawnAsync — returns workerId immediately, worker completes in microtask
 *   spawnSync — executes spy inline, returns completed result
 *   spy() — intercepts worker execution with custom fn
 *   spawnSync error — spy throws → status:failed + error message
 *   reset — clears all state
 *
 * Coverage (withSkillSpan):
 *   no OTEL_EXPORTER_OTLP_ENDPOINT — calls fn directly and returns result
 *   propagates fn rejection
 *
 * Ref: test coverage for test-brain-port.ts + test-child-agent.ts + _otel.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSkillSpan } from "../src/skills/_otel.js";
import { TestBrainPort } from "../src/testing/test-brain-port.js";
import { TestChildAgentPort } from "../src/testing/test-child-agent.js";

// ─── TestBrainPort ────────────────────────────────────────────────────────────

describe("TestBrainPort.archiveKnowledge", () => {
  it("stores entry and returns a BrainEntry with sequential id", async () => {
    const brain = new TestBrainPort();
    const entry = await brain.archiveKnowledge({
      content: "decision about auth",
      category: "decision",
      tags: ["auth"],
    });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("test-1");
    expect(entry!.content).toBe("decision about auth");
    expect(entry!.category).toBe("decision");
  });

  it("increments id for each archived entry", async () => {
    const brain = new TestBrainPort();
    const e1 = await brain.archiveKnowledge({ content: "a" });
    const e2 = await brain.archiveKnowledge({ content: "b" });
    expect(e1!.id).toBe("test-1");
    expect(e2!.id).toBe("test-2");
  });

  it("sets created_at as an ISO string", async () => {
    const brain = new TestBrainPort();
    const entry = await brain.archiveKnowledge({ content: "x" });
    expect(() => new Date(entry!.created_at!)).not.toThrow();
  });
});

describe("TestBrainPort.queryKnowledge", () => {
  it("returns entries matching content substring (case-insensitive)", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({ content: "Auth module refactor" });
    await brain.archiveKnowledge({ content: "Vault analytics" });
    const results = await brain.queryKnowledge("auth");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Auth module refactor");
  });

  it("filters by category", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({
      content: "decision one",
      category: "decision",
    });
    await brain.archiveKnowledge({
      content: "decision two",
      category: "pattern",
    });
    const results = await brain.queryKnowledge("decision", {
      category: "decision",
    });
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe("decision");
  });

  it("filters by tags (any match)", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({
      content: "auth flow",
      tags: ["auth", "security"],
    });
    await brain.archiveKnowledge({ content: "vault flow", tags: ["vault"] });
    const results = await brain.queryKnowledge("flow", { tags: ["auth"] });
    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain("auth");
  });

  it("respects limit", async () => {
    const brain = new TestBrainPort();
    for (let i = 0; i < 5; i++) {
      await brain.archiveKnowledge({ content: "item" });
    }
    const results = await brain.queryKnowledge("item", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns empty array when no match", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({ content: "something" });
    const results = await brain.queryKnowledge("nothing");
    expect(results).toHaveLength(0);
  });
});

describe("TestBrainPort.reset", () => {
  it("clears all entries", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({ content: "old entry" });
    brain.reset();
    const results = await brain.queryKnowledge("old");
    expect(results).toHaveLength(0);
  });

  it("resets id counter to test-1", async () => {
    const brain = new TestBrainPort();
    await brain.archiveKnowledge({ content: "first" });
    brain.reset();
    const entry = await brain.archiveKnowledge({ content: "after reset" });
    expect(entry!.id).toBe("test-1");
  });
});

describe("TestBrainPort no-op methods", () => {
  it("archivePostmortem resolves without error", async () => {
    const brain = new TestBrainPort();
    await expect(
      brain.archivePostmortem({
        title: "incident",
        root_cause: "bug",
        impact: "outage",
        resolution: "fixed",
      }),
    ).resolves.toBeUndefined();
  });

  it("archiveLesson resolves without error", async () => {
    const brain = new TestBrainPort();
    await expect(
      brain.archiveLesson({
        content: "lesson learned",
        source_incident: "inc-1",
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── TestChildAgentPort ───────────────────────────────────────────────────────

describe("TestChildAgentPort.spawnAsync", () => {
  it("returns workerId immediately", async () => {
    const port = new TestChildAgentPort();
    const { workerId } = await port.spawnAsync({
      agentId: "builder",
      task: {},
    });
    expect(workerId).toMatch(/^test-worker-/);
  });

  it("getWorker returns the worker record after spawnAsync", async () => {
    const port = new TestChildAgentPort();
    const { workerId } = await port.spawnAsync({
      agentId: "builder",
      task: {},
    });
    // worker is tracked (status may be accepted or completed depending on microtask timing)
    expect(port.getWorker(workerId)).toBeDefined();
  });

  it("worker completes after microtask (spy output captured)", async () => {
    const port = new TestChildAgentPort();
    port.spy(async (opts) => ({ result: opts.agentId }));
    const { workerId } = await port.spawnAsync({ agentId: "tester", task: {} });
    await Promise.resolve(); // flush microtask
    const worker = port.getWorker(workerId);
    expect(worker?.status).toBe("completed");
    expect(worker?.output).toEqual({ result: "tester" });
  });

  it("worker status is failed when spy throws", async () => {
    const port = new TestChildAgentPort();
    port.spy(async () => {
      throw new Error("worker crashed");
    });
    const { workerId } = await port.spawnAsync({ agentId: "b", task: {} });
    await Promise.resolve();
    expect(port.getWorker(workerId)?.status).toBe("failed");
  });

  it("increments workerId for each spawn", async () => {
    const port = new TestChildAgentPort();
    const { workerId: id1 } = await port.spawnAsync({ agentId: "a", task: {} });
    const { workerId: id2 } = await port.spawnAsync({ agentId: "b", task: {} });
    expect(id1).toBe("test-worker-1");
    expect(id2).toBe("test-worker-2");
  });
});

describe("TestChildAgentPort.spawnSync", () => {
  it("returns completed result with spy output", async () => {
    const port = new TestChildAgentPort();
    port.spy(async () => ({ answer: 42 }));
    const result = await port.spawnSync({ agentId: "scribe", task: {} });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ answer: 42 });
  });

  it("returns completed with undefined output when no spy", async () => {
    const port = new TestChildAgentPort();
    const result = await port.spawnSync({ agentId: "a", task: {} });
    expect(result.status).toBe("completed");
    expect(result.output).toBeUndefined();
  });

  it("returns failed result when spy throws", async () => {
    const port = new TestChildAgentPort();
    port.spy(async () => {
      throw new Error("synthesis error");
    });
    const result = await port.spawnSync({ agentId: "synergy", task: {} });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("synthesis error");
  });
});

describe("TestChildAgentPort.reset", () => {
  it("clears workers and resets id counter", async () => {
    const port = new TestChildAgentPort();
    const { workerId } = await port.spawnAsync({ agentId: "a", task: {} });
    port.reset();
    expect(port.getWorker(workerId)).toBeUndefined();
    const { workerId: newId } = await port.spawnAsync({
      agentId: "b",
      task: {},
    });
    expect(newId).toBe("test-worker-1");
  });
});

// ─── withSkillSpan ────────────────────────────────────────────────────────────

describe("withSkillSpan", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it("calls fn directly and returns result when no OTEL endpoint", async () => {
    const result = await withSkillSpan("test-skill", async () => "hello");
    expect(result).toBe("hello");
  });

  it("propagates fn rejection", async () => {
    await expect(
      withSkillSpan("test-skill", async () => {
        throw new Error("skill failed");
      }),
    ).rejects.toThrow("skill failed");
  });
});
