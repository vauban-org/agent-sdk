/**
 * initSDK — self-registration via registryOpts
 *
 * Verifies that when `registryOpts` is provided, `initSDK` calls
 * `registry.register(descriptor)` at boot (fire-and-forget, non-fatal).
 *
 * Ref: sprint-621:quick-5
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDescriptor, AgentRegistryPort } from "../src/ports/agent-registry.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Stub initVaubanSDK so the test has no OTel side-effects.
vi.mock("../src/otel/ingest.js", () => ({
  initVaubanSDK: vi.fn().mockReturnValue({ shutdown: vi.fn() }),
}));

// Import after mock is registered
const { initSDK } = await import("../src/boot/init-sdk.js");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_OPTS = {
  agentId: "cc:test-agent",
  agentVersion: "1.0.0",
  orgId: "cc",
};

const DESCRIPTOR: AgentDescriptor = {
  id: "cc:test-agent",
  product: "cc",
  capabilities: ["test"],
  inputSchema: { type: "object" },
  trigger: "event" as const,
};

function makeMockRegistry(overrides: Partial<AgentRegistryPort> = {}): AgentRegistryPort {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue([]),
    unregister: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("initSDK — registryOpts self-registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("calls registry.register(descriptor) when registryOpts is provided", async () => {
    const registry = makeMockRegistry();

    initSDK({
      ...BASE_OPTS,
      registryOpts: { registry, descriptor: DESCRIPTOR },
    });

    // Fire-and-forget: wait a tick for the Promise to resolve
    await Promise.resolve();

    expect(registry.register).toHaveBeenCalledOnce();
    expect(registry.register).toHaveBeenCalledWith(DESCRIPTOR);
  });

  test("does not call registry.register when registryOpts is omitted", async () => {
    const registry = makeMockRegistry();

    initSDK({ ...BASE_OPTS });

    await Promise.resolve();

    expect(registry.register).not.toHaveBeenCalled();
  });

  test("does not throw when registry.register rejects (non-fatal)", async () => {
    const registry = makeMockRegistry({
      register: vi.fn().mockRejectedValue(new Error("DB down")),
    });

    // Should not throw
    expect(() =>
      initSDK({
        ...BASE_OPTS,
        registryOpts: { registry, descriptor: DESCRIPTOR },
      }),
    ).not.toThrow();

    // Await so the rejected promise is handled (no unhandled rejection)
    await Promise.resolve();
  });

  test("returns a BasicTracerProvider (OTel provider)", () => {
    const provider = initSDK({ ...BASE_OPTS });
    expect(provider).toBeDefined();
  });
});
