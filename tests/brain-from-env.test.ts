/**
 * Tests for createBrainPortFromEnv — env-driven HTTP BrainPort assembly.
 *
 * The V12 memory planes (Working / Episodic / Claims) only reach prod when an
 * HTTP-backed BrainPort is wired into an agent's deps.memory. This helper
 * builds that adapter from the deployment env contract (BRAIN_URL +
 * BRAIN_TOKEN | BRAIN_API_KEY), so createOODAAgent can auto-wire every agent.
 *
 * Ref: fix(agent-sdk): auto-wire V12 memory planes into every OODA agent
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrainPortFromEnv } from "../src/adapters/brain-http.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createBrainPortFromEnv", () => {
  it("returns undefined when BRAIN_URL is absent (zero-regression)", () => {
    vi.stubEnv("BRAIN_URL", undefined);
    expect(createBrainPortFromEnv("agent-x")).toBeUndefined();
  });

  it("returns undefined when BRAIN_URL is an empty string", () => {
    vi.stubEnv("BRAIN_URL", "");
    expect(createBrainPortFromEnv("agent-x")).toBeUndefined();
  });

  it("builds a BrainPort with episodic + claims planes when BRAIN_URL is set", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    vi.stubEnv("BRAIN_TOKEN", "tok");
    const port = createBrainPortFromEnv("agent-x");
    expect(port).toBeDefined();
    expect(port?.episodic).toBeDefined();
    expect(port?.claims).toBeDefined();
  });

  it("wires the working plane only when an agentId is supplied", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    expect(createBrainPortFromEnv("agent-x")?.working).toBeDefined();
    expect(createBrainPortFromEnv(undefined)?.working).toBeUndefined();
  });

  it("accepts BRAIN_API_KEY as the auth fallback when no BRAIN_TOKEN is set", () => {
    vi.stubEnv("BRAIN_URL", "https://brain.api.vauban.tech");
    vi.stubEnv("BRAIN_TOKEN", undefined);
    vi.stubEnv("BRAIN_API_KEY", "key-123");
    expect(createBrainPortFromEnv("agent-x")?.episodic).toBeDefined();
  });
});
