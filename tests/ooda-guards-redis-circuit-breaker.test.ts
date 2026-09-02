/**
 * Tests for redis-circuit-breaker RiskGuard.
 *
 * All Redis interactions are mocked via _redisClientFactory injection —
 * no real Redis connection is required.
 *
 * Ref: ooda/guards/redis-circuit-breaker.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  type MinimalRedisClient,
  redisCircuitBreaker,
  resetCircuitBreaker,
  tripCircuitBreaker,
} from "../src/orchestration/ooda/guards/redis-circuit-breaker.js";
import type { OODAContext } from "../src/orchestration/ooda/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a mock Redis client factory. `isTripped=true` → get() returns '1'. */
function makeRedisFactory(isTripped: boolean): (url: string) => MinimalRedisClient {
  return vi.fn().mockReturnValue({
    get: vi.fn().mockResolvedValue(isTripped ? "1" : null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
  });
}

/** Minimal OODAContext stub — only what check() needs (nothing). */
const fakeCtx = {} as OODAContext;

// ─── Guard shape ──────────────────────────────────────────────────────────────

describe("redisCircuitBreaker — shape", () => {
  it("creates a RiskGuard with a name field", () => {
    const guard = redisCircuitBreaker({
      name: "test-guard",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(false),
    });
    expect(guard).toBeDefined();
    expect(typeof guard.name).toBe("string");
  });

  it("guard has a check method", () => {
    const guard = redisCircuitBreaker({
      name: "test-guard",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(false),
    });
    expect(typeof guard.check).toBe("function");
  });

  it("name field is 'redis-cb:<name>'", () => {
    const guard = redisCircuitBreaker({
      name: "my-breaker",
      failureThreshold: 5,
      resetVia: "admin-endpoint",
      _redisClientFactory: makeRedisFactory(false),
    });
    expect(guard.name).toBe("redis-cb:my-breaker");
  });

  it("name field matches options.name (different names)", () => {
    const g1 = redisCircuitBreaker({
      name: "alpha",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: makeRedisFactory(false),
    });
    const g2 = redisCircuitBreaker({
      name: "beta",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: makeRedisFactory(false),
    });
    expect(g1.name).not.toBe(g2.name);
    expect(g1.name).toBe("redis-cb:alpha");
    expect(g2.name).toBe("redis-cb:beta");
  });
});

// ─── check() — allowed path ───────────────────────────────────────────────────

describe("redisCircuitBreaker — check() allowed (circuit clear)", () => {
  it("returns proceed=true when Redis returns null (circuit not tripped)", async () => {
    const guard = redisCircuitBreaker({
      name: "clear-cb",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(false),
    });
    const result = await guard.check(fakeCtx);
    expect(result.proceed).toBe(true);
  });

  it("allowed result has correct proceed=true (exact value, not just truthy)", async () => {
    const guard = redisCircuitBreaker({
      name: "clear-cb-2",
      failureThreshold: 2,
      resetVia: "admin-endpoint",
      _redisClientFactory: makeRedisFactory(false),
    });
    const result = await guard.check(fakeCtx);
    expect(result.proceed).toStrictEqual(true);
  });

  it("allowed result has no reason string (or undefined)", async () => {
    const guard = redisCircuitBreaker({
      name: "clear-reason",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: makeRedisFactory(false),
    });
    const result = await guard.check(fakeCtx);
    // reason is optional when circuit is clear
    expect(result.reason).toBeUndefined();
  });
});

// ─── check() — blocked path ───────────────────────────────────────────────────

describe("redisCircuitBreaker — check() blocked (circuit tripped)", () => {
  it("returns proceed=false when Redis returns '1' (tripped)", async () => {
    const guard = redisCircuitBreaker({
      name: "tripped-cb",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(true),
    });
    const result = await guard.check(fakeCtx);
    expect(result.proceed).toBe(false);
  });

  it("blocked result has proceed=false (exact value)", async () => {
    const guard = redisCircuitBreaker({
      name: "tripped-cb-2",
      failureThreshold: 3,
      resetVia: "admin-endpoint",
      _redisClientFactory: makeRedisFactory(true),
    });
    const result = await guard.check(fakeCtx);
    expect(result.proceed).toStrictEqual(false);
  });

  it("reason string includes the guard name when tripped", async () => {
    const guard = redisCircuitBreaker({
      name: "my-named-cb",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(true),
    });
    const result = await guard.check(fakeCtx);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("my-named-cb");
  });

  it("reason string includes resetVia when tripped", async () => {
    const guard = redisCircuitBreaker({
      name: "reset-via-cb",
      failureThreshold: 2,
      resetVia: "admin-endpoint",
      _redisClientFactory: makeRedisFactory(true),
    });
    const result = await guard.check(fakeCtx);
    expect(result.reason).toContain("admin-endpoint");
  });

  it("reason string includes resetVia='never' when set to never", async () => {
    const guard = redisCircuitBreaker({
      name: "never-reset-cb",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: makeRedisFactory(true),
    });
    const result = await guard.check(fakeCtx);
    expect(result.reason).toContain("never");
  });
});

// ─── check() — Redis client lifecycle ────────────────────────────────────────

describe("redisCircuitBreaker — check() Redis client lifecycle", () => {
  it("calls quit() on the Redis client after a successful check", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    const guard = redisCircuitBreaker({
      name: "quit-test",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: factory,
    });
    await guard.check(fakeCtx);
    expect(mockClient.quit).toHaveBeenCalledOnce();
  });

  it("calls quit() on the Redis client even when circuit is tripped", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue("1"),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    const guard = redisCircuitBreaker({
      name: "quit-tripped",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: factory,
    });
    await guard.check(fakeCtx);
    expect(mockClient.quit).toHaveBeenCalledOnce();
  });

  it("uses correct Redis key pattern cb:<name>:tripped", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    const guard = redisCircuitBreaker({
      name: "key-test",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: factory,
    });
    await guard.check(fakeCtx);
    expect(mockClient.get).toHaveBeenCalledWith("cb:key-test:tripped");
  });

  it("works with redisUrl=undefined (falls back to env / default)", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    const guard = redisCircuitBreaker({
      name: "no-url",
      failureThreshold: 2,
      resetVia: "cron-rth",
      // redisUrl intentionally omitted
      _redisClientFactory: factory,
    });
    // Should not throw — factory handles URL resolution
    const result = await guard.check(fakeCtx);
    expect(result.proceed).toBe(true);
  });
});

// ─── tripCircuitBreaker helper ────────────────────────────────────────────────

describe("tripCircuitBreaker", () => {
  it("calls Redis set with '1' and the correct key", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    await tripCircuitBreaker("redis://localhost:6379", "my-cb", factory);
    expect(mockClient.set).toHaveBeenCalledWith("cb:my-cb:tripped", "1");
  });

  it("calls quit() after setting the key", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    await tripCircuitBreaker("redis://localhost:6379", "trip-quit-test", factory);
    expect(mockClient.quit).toHaveBeenCalledOnce();
  });
});

// ─── resetCircuitBreaker helper ───────────────────────────────────────────────

describe("resetCircuitBreaker", () => {
  it("calls Redis del with the correct key", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue("1"),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    await resetCircuitBreaker("redis://localhost:6379", "my-cb", factory);
    expect(mockClient.del).toHaveBeenCalledWith("cb:my-cb:tripped");
  });

  it("calls quit() after deleting the key", async () => {
    const mockClient: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue("1"),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const factory = vi.fn().mockReturnValue(mockClient);
    await resetCircuitBreaker("redis://localhost:6379", "reset-quit-test", factory);
    expect(mockClient.quit).toHaveBeenCalledOnce();
  });
});

// ─── failureThreshold field ───────────────────────────────────────────────────

describe("redisCircuitBreaker — options passthrough", () => {
  it("guard object does not expose failureThreshold directly (informational only via options)", () => {
    // failureThreshold is on options, not on the returned RiskGuard.
    // The guard interface only exposes name + check().
    const guard = redisCircuitBreaker({
      name: "threshold-test",
      failureThreshold: 7,
      resetVia: "cron-rth",
      _redisClientFactory: makeRedisFactory(false),
    });
    // name and check are the only RiskGuard contract fields
    expect(Object.keys(guard)).toContain("name");
    expect(Object.keys(guard)).toContain("check");
  });

  it("two guards with different names use different Redis keys", async () => {
    const clientA: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const clientB: MinimalRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue("OK"),
    };
    const guardA = redisCircuitBreaker({
      name: "guard-a",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: vi.fn().mockReturnValue(clientA),
    });
    const guardB = redisCircuitBreaker({
      name: "guard-b",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: vi.fn().mockReturnValue(clientB),
    });
    await guardA.check(fakeCtx);
    await guardB.check(fakeCtx);
    expect(clientA.get).toHaveBeenCalledWith("cb:guard-a:tripped");
    expect(clientB.get).toHaveBeenCalledWith("cb:guard-b:tripped");
  });
});
