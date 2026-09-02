/**
 * Tests for packages/agent-sdk/src/auth/nonce-store.ts
 *
 * Coverage:
 *   InMemoryNonceStore — first call returns true, duplicate returns false,
 *                        expired entry allows re-use, reset() clears state
 *   RedisNonceStore — "OK" response → true, null response → false, key prefix
 *
 * Ref: test coverage for agent-sdk/auth/nonce-store.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryNonceStore, RedisNonceStore } from "../src/auth/nonce-store.js";

// ─── InMemoryNonceStore ───────────────────────────────────────────────────────

describe("InMemoryNonceStore", () => {
  let store: InMemoryNonceStore;

  beforeEach(() => {
    store = new InMemoryNonceStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for a new nonce", async () => {
    expect(await store.setNX("nonce-1", 60_000)).toBe(true);
  });

  it("returns false for a duplicate nonce within TTL", async () => {
    await store.setNX("nonce-dup", 60_000);
    expect(await store.setNX("nonce-dup", 60_000)).toBe(false);
  });

  it("allows re-use of an expired nonce", async () => {
    await store.setNX("nonce-exp", 1_000);
    // Advance time past TTL
    vi.advanceTimersByTime(2_000);
    expect(await store.setNX("nonce-exp", 1_000)).toBe(true);
  });

  it("different keys are independent", async () => {
    await store.setNX("key-a", 60_000);
    expect(await store.setNX("key-b", 60_000)).toBe(true);
  });

  it("reset() clears all state so re-use is allowed", async () => {
    await store.setNX("nonce-reset", 60_000);
    store.reset();
    expect(await store.setNX("nonce-reset", 60_000)).toBe(true);
  });
});

// ─── RedisNonceStore ──────────────────────────────────────────────────────────

describe("RedisNonceStore", () => {
  const mockSet = vi.fn();
  const redis = { set: mockSet };
  let store: RedisNonceStore;

  beforeEach(() => {
    store = new RedisNonceStore(redis);
    vi.clearAllMocks();
  });

  it("returns true when Redis SET NX returns 'OK'", async () => {
    mockSet.mockResolvedValue("OK");
    expect(await store.setNX("nonce-1", 10_000)).toBe(true);
  });

  it("returns false when Redis SET NX returns null (key exists)", async () => {
    mockSet.mockResolvedValue(null);
    expect(await store.setNX("nonce-dup", 10_000)).toBe(false);
  });

  it("calls redis.set with vauban:nonce: prefix", async () => {
    mockSet.mockResolvedValue("OK");
    await store.setNX("abc123", 5_000);
    expect(mockSet).toHaveBeenCalledWith("vauban:nonce:abc123", "1", {
      nx: true,
      px: 5_000,
    });
  });

  it("passes ttlMs as px option", async () => {
    mockSet.mockResolvedValue("OK");
    await store.setNX("key", 30_000);
    const [, , opts] = mockSet.mock.calls[0];
    expect(opts.px).toBe(30_000);
    expect(opts.nx).toBe(true);
  });
});
