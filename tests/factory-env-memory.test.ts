/**
 * Tests for applyEnvMemory — the createOODAAgent auto-wiring of V12 memory.
 *
 * Every OODA agent is constructed via createOODAAgent(). When the host does
 * not inject an explicit deps.memory, applyEnvMemory defaults it from the env
 * HTTP brain adapter so the OODA loop's _appendEpisodic / _assertOutcomeClaim
 * writers light up for EVERY agent (present and future). Zero-regression: no
 * BRAIN_URL → no memory port; explicit memory always wins; kill-switch honored.
 *
 * Ref: fix(agent-sdk): auto-wire V12 memory planes into every OODA agent
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEnvMemory } from "../src/orchestration/ooda/factory.js";
import type { BrainPort } from "../src/ports/brain.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

interface MiniConfig {
  agentId: string;
  deps?: { llm?: unknown; memory?: BrainPort };
}

function baseConfig(): MiniConfig {
  return { agentId: "narrator", deps: { llm: {} } };
}

describe("applyEnvMemory", () => {
  it("auto-wires deps.memory from env when absent and BRAIN_URL is set", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    const out = applyEnvMemory(baseConfig());
    expect(out.deps?.memory).toBeDefined();
    expect(out.deps?.memory?.episodic).toBeDefined();
    expect(out.deps?.memory?.claims).toBeDefined();
  });

  it("leaves an explicitly-provided memory port untouched", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    const explicit = { episodic: {}, claims: {} } as unknown as BrainPort;
    const cfg: MiniConfig = { agentId: "narrator", deps: { llm: {}, memory: explicit } };
    expect(applyEnvMemory(cfg).deps?.memory).toBe(explicit);
  });

  it("does nothing when BRAIN_URL is absent (zero-regression)", () => {
    vi.stubEnv("BRAIN_URL", undefined);
    expect(applyEnvMemory(baseConfig()).deps?.memory).toBeUndefined();
  });

  it("honors the SDK_AUTO_MEMORY=false kill-switch", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    vi.stubEnv("SDK_AUTO_MEMORY", "false");
    expect(applyEnvMemory(baseConfig()).deps?.memory).toBeUndefined();
  });

  it("does not touch a legacy config with no deps object", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    const cfg: MiniConfig = { agentId: "narrator" };
    expect(applyEnvMemory(cfg).deps).toBeUndefined();
  });

  it("keys the wired adapter to the agent's own id (working plane present)", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    expect(applyEnvMemory(baseConfig()).deps?.memory?.working).toBeDefined();
  });
});
