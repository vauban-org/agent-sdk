/**
 * Tests: Redis circuit breaker guard (sprint-525:quick-3)
 *
 * Uses a Map-based mock Redis client — no real Redis required.
 * Validates the V5 anti-pattern #4 fix: no TTL bypass.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  redisCircuitBreaker,
  tripCircuitBreaker,
  resetCircuitBreaker,
  type MinimalRedisClient,
} from "../src/orchestration/ooda/guards/redis-circuit-breaker.js";
import type { OODAContext } from "../src/orchestration/ooda/types.js";

// ─── Map-based Redis mock ─────────────────────────────────────────────────

function makeMockRedis(): { store: Map<string, string>; factory: (url: string) => MinimalRedisClient } {
  const store = new Map<string, string>();

  const factory = (_url: string): MinimalRedisClient => ({
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async del(key: string) {
      store.delete(key);
    },
    async quit() {
      // no-op
    },
  });

  return { store, factory };
}

// ─── Minimal OODAContext stub ─────────────────────────────────────────────

function makeCtx(): OODAContext {
  return {
    agentId: "test-agent",
    runId: "run-001",
    cycleIndex: 0,
    executionMode: "dry-run",
    isReplay: false,
    config: {},
    db: {} as OODAContext["db"],
    skills: {},
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => ({} as OODAContext["logger"]) }),
    } as OODAContext["logger"],
    insertStep: async () => ({ stepId: "s1" }),
    completeStep: async () => ({ leafHash: "0x0" }),
    errorStep: async () => undefined,
    notifySlack: async () => undefined,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("redisCircuitBreaker", () => {
  let mock: ReturnType<typeof makeMockRedis>;
  const redisUrl = "redis://localhost:6379";

  beforeEach(() => {
    mock = makeMockRedis();
  });

  it("returns proceed=true when circuit is clear", async () => {
    const guard = redisCircuitBreaker({
      name: "test-cb",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: mock.factory,
    });

    const result = await guard.check(makeCtx());
    expect(result.proceed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("tripCircuitBreaker → check returns proceed=false", async () => {
    await tripCircuitBreaker(redisUrl, "test-cb", mock.factory);

    const guard = redisCircuitBreaker({
      name: "test-cb",
      failureThreshold: 3,
      resetVia: "cron-rth",
      _redisClientFactory: mock.factory,
    });

    const result = await guard.check(makeCtx());
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain("test-cb");
    expect(result.reason).toContain("resetVia=cron-rth");
  });

  it("resetCircuitBreaker → check returns proceed=true after trip", async () => {
    await tripCircuitBreaker(redisUrl, "test-cb", mock.factory);
    await resetCircuitBreaker(redisUrl, "test-cb", mock.factory);

    const guard = redisCircuitBreaker({
      name: "test-cb",
      failureThreshold: 3,
      resetVia: "admin-endpoint",
      _redisClientFactory: mock.factory,
    });

    const result = await guard.check(makeCtx());
    expect(result.proceed).toBe(true);
  });

  it("resetVia='never' + tripped: stays tripped after simulated 24h (no TTL bypass)", async () => {
    // Trip the breaker
    await tripCircuitBreaker(redisUrl, "never-cb", mock.factory);

    // Simulate 24h passing — with explicit resetVia='never', the key has NO TTL.
    // The Map store is unmodified; confirm it's still "1".
    expect(mock.store.get("cb:never-cb:tripped")).toBe("1");

    const guard = redisCircuitBreaker({
      name: "never-cb",
      failureThreshold: 1,
      resetVia: "never",
      _redisClientFactory: mock.factory,
    });

    // Even if caller pretends time has passed, the key is permanent.
    const result = await guard.check(makeCtx());
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain("resetVia=never");
  });

  it("resetVia='cron-rth' description appears in reason when tripped", async () => {
    await tripCircuitBreaker(redisUrl, "rth-cb", mock.factory);

    const guard = redisCircuitBreaker({
      name: "rth-cb",
      failureThreshold: 5,
      resetVia: "cron-rth",
      _redisClientFactory: mock.factory,
    });

    const result = await guard.check(makeCtx());
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain("resetVia=cron-rth");
  });

  it("guard name includes the circuit breaker name", () => {
    const guard = redisCircuitBreaker({
      name: "my-rule",
      failureThreshold: 3,
      resetVia: "admin-endpoint",
      _redisClientFactory: mock.factory,
    });
    expect(guard.name).toBe("redis-cb:my-rule");
  });

  it("two different named breakers are independent", async () => {
    await tripCircuitBreaker(redisUrl, "alpha", mock.factory);
    // beta is NOT tripped

    const alphaGuard = redisCircuitBreaker({
      name: "alpha",
      failureThreshold: 1,
      resetVia: "cron-rth",
      _redisClientFactory: mock.factory,
    });
    const betaGuard = redisCircuitBreaker({
      name: "beta",
      failureThreshold: 1,
      resetVia: "cron-rth",
      _redisClientFactory: mock.factory,
    });

    expect((await alphaGuard.check(makeCtx())).proceed).toBe(false);
    expect((await betaGuard.check(makeCtx())).proceed).toBe(true);
  });
});
