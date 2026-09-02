import { describe, expect, it, vi } from "vitest";

import {
  NO_RETRY,
  RETRY_AGGRESSIVE,
  RETRY_PATIENT,
  RETRY_TRANSIENT,
  type RetryConfig,
  RetryContext,
  RetryExhaustedError,
  calculateDelay,
  retry,
  shouldRetry,
} from "../../src/retry/index.js";

const NO_JITTER: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  exponentialBase: 2.0,
  jitter: false,
};

const FAST_SLEEP = () => Promise.resolve();

describe("calculateDelay", () => {
  it("returns exact exponential delay without jitter", () => {
    expect(calculateDelay(NO_JITTER, 0)).toBe(100);
    expect(calculateDelay(NO_JITTER, 1)).toBe(200);
    expect(calculateDelay(NO_JITTER, 2)).toBe(400);
    expect(calculateDelay(NO_JITTER, 3)).toBe(800);
  });

  it("caps at maxDelayMs", () => {
    const cfg: RetryConfig = {
      ...NO_JITTER,
      baseDelayMs: 1000,
      maxDelayMs: 2500,
    };
    expect(calculateDelay(cfg, 0)).toBe(1000);
    expect(calculateDelay(cfg, 1)).toBe(2000);
    expect(calculateDelay(cfg, 2)).toBe(2500); // 4000 capped
    expect(calculateDelay(cfg, 5)).toBe(2500); // 32000 capped
  });

  it("stays within ±25% jitter range and never negative", () => {
    const cfg: RetryConfig = { ...NO_JITTER, jitter: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      const expected = 100 * 2 ** attempt;
      const range = expected * 0.25;
      for (let s = 0; s < 200; s++) {
        const v = calculateDelay(cfg, attempt);
        expect(v).toBeGreaterThanOrEqual(Math.max(0, expected - range));
        expect(v).toBeLessThanOrEqual(expected + range);
      }
    }
  });

  it("uses injected randomFn instead of Math.random for deterministic jitter", () => {
    const cfg: RetryConfig = { ...NO_JITTER, jitter: true };
    // randomFn=0 -> offset = -jitterRange (minimum of the range).
    expect(calculateDelay(cfg, 0, () => 0)).toBe(75);
    // randomFn=1 -> offset = +jitterRange (maximum of the range).
    expect(calculateDelay(cfg, 0, () => 1)).toBe(125);
    // randomFn=0.5 -> offset = 0 (exact exponential value, no jitter).
    expect(calculateDelay(cfg, 0, () => 0.5)).toBe(100);
  });

  it("defaults randomFn to Math.random when omitted (backward compatible)", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const cfg: RetryConfig = { ...NO_JITTER, jitter: true };
      expect(calculateDelay(cfg, 0)).toBe(100);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("shouldRetry", () => {
  it("returns false on the last attempt", () => {
    expect(shouldRetry(NO_JITTER, new Error("x"), 2)).toBe(false);
    expect(shouldRetry(NO_JITTER, new Error("x"), 1)).toBe(true);
  });

  it("respects retryIf predicate", () => {
    const cfg: RetryConfig = {
      ...NO_JITTER,
      retryIf: (e) => (e as Error).message === "retry",
    };
    expect(shouldRetry(cfg, new Error("retry"), 0)).toBe(true);
    expect(shouldRetry(cfg, new Error("stop"), 0)).toBe(false);
  });

  it("respects retryOn class filter", () => {
    class NetworkError extends Error {}
    class FatalError extends Error {}
    const cfg: RetryConfig = { ...NO_JITTER, retryOn: [NetworkError] };
    expect(shouldRetry(cfg, new NetworkError(), 0)).toBe(true);
    expect(shouldRetry(cfg, new FatalError(), 0)).toBe(false);
  });

  it("retryIf takes precedence over retryOn", () => {
    class NetworkError extends Error {}
    const cfg: RetryConfig = {
      ...NO_JITTER,
      retryOn: [NetworkError],
      retryIf: () => false,
    };
    expect(shouldRetry(cfg, new NetworkError(), 0)).toBe(false);
  });
});

describe("retry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn(async () => 42);
    expect(await retry(fn, { config: NO_JITTER, sleepFn: FAST_SLEEP })).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return "ok";
    });
    expect(await retry(fn, { config: NO_JITTER, sleepFn: FAST_SLEEP })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws RetryExhaustedError after all attempts fail", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });
    await expect(retry(fn, { config: NO_JITTER, sleepFn: FAST_SLEEP })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-retryable errors as-is without consuming attempts", async () => {
    class FatalError extends Error {}
    const cfg: RetryConfig = { ...NO_JITTER, retryOn: [TypeError] };
    const fn = vi.fn(async () => {
      throw new FatalError("nope");
    });
    await expect(retry(fn, { config: cfg, sleepFn: FAST_SLEEP })).rejects.toBeInstanceOf(
      FatalError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("invokes onRetry callback with err, attempt, delay", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 2) throw new Error("first");
      return "ok";
    };
    await retry(fn, { config: NO_JITTER, sleepFn: FAST_SLEEP, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [err, attempt, delay] = onRetry.mock.calls[0]!;
    expect((err as Error).message).toBe("first");
    expect(attempt).toBe(0);
    expect(delay).toBe(100);
  });

  it("uses injected sleepFn (deterministic test path)", async () => {
    const sleepFn = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error("x");
    });
    await expect(retry(fn, { config: NO_JITTER, sleepFn })).rejects.toBeInstanceOf(
      RetryExhaustedError,
    );
    expect(sleepFn).toHaveBeenCalledTimes(2); // 3 attempts → 2 sleeps
  });

  it("RetryExhaustedError exposes attempts and lastError", async () => {
    const lastErr = new Error("final");
    let i = 0;
    const fn = async () => {
      i += 1;
      throw i < 3 ? new Error("transient") : lastErr;
    };
    try {
      await retry(fn, { config: NO_JITTER, sleepFn: FAST_SLEEP });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      const e = err as RetryExhaustedError;
      expect(e.attempts).toBe(3);
      expect(e.lastError).toBe(lastErr);
    }
  });

  it("uses RETRY_TRANSIENT by default when no config passed", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await retry(fn, { sleepFn: FAST_SLEEP })).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("threads randomFn into jitter delay computation", async () => {
    const cfg: RetryConfig = { ...NO_JITTER, jitter: true };
    const delays: number[] = [];
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return "ok";
    };
    await retry(fn, {
      config: cfg,
      sleepFn: FAST_SLEEP,
      randomFn: () => 0,
      onRetry: (_err, _attempt, delay) => delays.push(delay),
    });
    // randomFn pinned at 0 -> offset = -jitterRange -> deterministic 75, 150.
    expect(delays).toEqual([75, 150]);
  });
});

describe("RetryContext", () => {
  it("starts with shouldContinue true and attempt 0", () => {
    const ctx = new RetryContext({ config: NO_JITTER, sleepFn: FAST_SLEEP });
    expect(ctx.shouldContinue).toBe(true);
    expect(ctx.attempt).toBe(0);
  });

  it("increments attempt and sleeps between tries", async () => {
    const sleepFn = vi.fn(async () => undefined);
    const ctx = new RetryContext({ config: NO_JITTER, sleepFn });
    await ctx.handleError(new Error("a"));
    expect(ctx.attempt).toBe(1);
    expect(ctx.shouldContinue).toBe(true);
    expect(sleepFn).toHaveBeenCalledOnce();
  });

  it("throws RetryExhaustedError after maxAttempts errors", async () => {
    const ctx = new RetryContext({ config: NO_JITTER, sleepFn: FAST_SLEEP });
    await ctx.handleError(new Error("a"));
    await ctx.handleError(new Error("b"));
    await expect(ctx.handleError(new Error("c"))).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(ctx.shouldContinue).toBe(false);
  });

  it("re-throws non-retryable error as-is and stops", async () => {
    class FatalError extends Error {}
    const cfg: RetryConfig = { ...NO_JITTER, retryOn: [TypeError] };
    const ctx = new RetryContext({ config: cfg, sleepFn: FAST_SLEEP });
    await expect(ctx.handleError(new FatalError("stop"))).rejects.toBeInstanceOf(FatalError);
    expect(ctx.shouldContinue).toBe(false);
  });
});

describe("presets", () => {
  it("RETRY_TRANSIENT: 3 attempts, 1s base, 10s cap, jitter on", () => {
    expect(RETRY_TRANSIENT.maxAttempts).toBe(3);
    expect(RETRY_TRANSIENT.baseDelayMs).toBe(1000);
    expect(RETRY_TRANSIENT.maxDelayMs).toBe(10_000);
    expect(RETRY_TRANSIENT.jitter).toBe(true);
  });

  it("RETRY_AGGRESSIVE: 5 attempts, 500ms base, 30s cap", () => {
    expect(RETRY_AGGRESSIVE.maxAttempts).toBe(5);
    expect(RETRY_AGGRESSIVE.baseDelayMs).toBe(500);
    expect(RETRY_AGGRESSIVE.maxDelayMs).toBe(30_000);
    expect(RETRY_AGGRESSIVE.jitter).toBe(true);
  });

  it("RETRY_PATIENT: 10 attempts, 2s base, 120s cap", () => {
    expect(RETRY_PATIENT.maxAttempts).toBe(10);
    expect(RETRY_PATIENT.baseDelayMs).toBe(2000);
    expect(RETRY_PATIENT.maxDelayMs).toBe(120_000);
    expect(RETRY_PATIENT.jitter).toBe(true);
  });

  it("NO_RETRY: single attempt only", () => {
    expect(NO_RETRY.maxAttempts).toBe(1);
    expect(NO_RETRY.jitter).toBe(false);
  });

  it("RETRY_TRANSIENT honors retryable=true flag on errors", () => {
    const retryable = { name: "X", message: "y", retryable: true };
    const notRetryable = { name: "X", message: "y", retryable: false };
    const noFlag = new Error("plain");
    expect(RETRY_TRANSIENT.retryIf?.(retryable)).toBe(true);
    expect(RETRY_TRANSIENT.retryIf?.(notRetryable)).toBe(false);
    expect(RETRY_TRANSIENT.retryIf?.(noFlag)).toBe(true); // default to retry when flag absent
  });
});
