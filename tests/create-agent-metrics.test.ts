/**
 * Tests for agent-sdk/src/metrics/create-agent-metrics.ts
 *
 * Coverage:
 *   createAgentMetrics — returns 8-metric AgentMetrics object,
 *     no-op mode (prom-client absent): all metrics callable without error,
 *     .inc() is safe, .observe() is safe, .labels() is safe,
 *     no-op counter returns self from .labels() (chain)
 *
 * Note: prom-client is a peerDependencyOptional — these tests run in no-op mode
 *       (prom-client not installed in the SDK package).
 *
 * Ref: test coverage for agent-sdk/metrics/create-agent-metrics.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { createAgentMetrics } from "../src/metrics/create-agent-metrics.js";

describe("createAgentMetrics — no-op mode (prom-client absent)", () => {
  it("returns an object with all 8 required metric keys", () => {
    const m = createAgentMetrics();
    expect(m).toHaveProperty("cycleStarted");
    expect(m).toHaveProperty("cycleCompleted");
    expect(m).toHaveProperty("cycleDuration");
    expect(m).toHaveProperty("hitlRequested");
    expect(m).toHaveProperty("hitlResolved");
    expect(m).toHaveProperty("llmCallCount");
    expect(m).toHaveProperty("llmTokensUsed");
    expect(m).toHaveProperty("llmCostUsd");
  });

  it("cycleStarted.inc() is callable without error", () => {
    const m = createAgentMetrics();
    expect(() => m.cycleStarted.inc({ agent_id: "test" })).not.toThrow();
  });

  it("cycleCompleted.inc() is callable without error", () => {
    const m = createAgentMetrics();
    expect(() => m.cycleCompleted.inc({ agent_id: "test", outcome: "success" })).not.toThrow();
  });

  it("cycleDuration.observe() is callable without error", () => {
    const m = createAgentMetrics();
    expect(() => m.cycleDuration.observe({ agent_id: "test", phase: "total" }, 250)).not.toThrow();
  });

  it("cycleDuration.startTimer() returns a function", () => {
    const m = createAgentMetrics();
    const end = m.cycleDuration.startTimer();
    expect(typeof end).toBe("function");
    expect(() => end()).not.toThrow();
  });

  it("labels() returns a chainable stub (counter)", () => {
    const m = createAgentMetrics();
    const labeled = m.cycleStarted.labels({ agent_id: "forge" });
    expect(labeled).toBeDefined();
    // Chain: labels().inc() must not throw
    expect(() => (labeled as { inc: () => void }).inc()).not.toThrow();
  });

  it("llmTokensUsed.inc() is callable with all 3 labels", () => {
    const m = createAgentMetrics();
    expect(() =>
      m.llmTokensUsed.inc({
        agent_id: "tester",
        provider: "groq",
        direction: "input",
      }),
    ).not.toThrow();
  });

  it("hitlResolved.inc() is callable without error", () => {
    const m = createAgentMetrics();
    expect(() => m.hitlResolved.inc({ agent_id: "test", decision: "approved" })).not.toThrow();
  });

  it("createAgentMetrics with custom prefix still returns valid metrics", () => {
    const m = createAgentMetrics({ prefix: "forge_" });
    expect(() => m.llmCostUsd.inc({ agent_id: "forge", provider: "groq" })).not.toThrow();
  });
});
