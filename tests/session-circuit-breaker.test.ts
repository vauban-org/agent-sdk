/**
 * Tests for agent-sdk/src/patterns/circuit-breaker/session-cb.ts
 *
 * Coverage:
 *   name — prefixed with 'session-cb:'
 *   check — proceed:true when closed+under thresholds,
 *            proceed:false when open within resetAfterMs
 *   recordTokens — trips when tokenCount > maxTokens, accumulates costUsd
 *   recordError — trips when consecutiveErrors >= maxConsecutiveErrors
 *   recordAction — trips when actionCount > maxActionCount
 *   elapsed — trips when elapsed > maxElapsedMs
 *   cost — trips when estimatedCostUsd > maxCostUsd
 *   half-open — transitions after resetAfterMs, recordSuccess → closed,
 *               recordError during probe re-trips to open
 *   reset — clears all state back to closed
 *   snapshot — reflects current counter values
 *   onTrip callback — invoked on first trip, not on re-trip
 *   idempotent trip — doTrip is no-op when already open
 *
 * Ref: test coverage for agent-sdk/patterns/circuit-breaker/session-cb.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import { createSessionCircuitBreaker } from "../src/patterns/circuit-breaker/session-cb.js";

const CTX = {} as never;

function makeCb(overrides: Parameters<typeof createSessionCircuitBreaker>[0] = {}) {
  return createSessionCircuitBreaker({
    name: "test",
    thresholds: {
      maxTokens: 100,
      maxConsecutiveErrors: 3,
      maxActionCount: 10,
      maxElapsedMs: 60_000,
      maxCostUsd: 1.0,
    },
    resetAfterMs: 5_000,
    ...overrides,
  });
}

// ─── name ─────────────────────────────────────────────────────────────────────

describe("SessionCircuitBreaker name", () => {
  it("is prefixed with session-cb:", () => {
    const cb = makeCb({ name: "forge" });
    expect(cb.name).toBe("session-cb:forge");
  });
});

// ─── check — closed state ─────────────────────────────────────────────────────

describe("check — closed state", () => {
  it("returns proceed:true when no thresholds breached", async () => {
    const cb = makeCb();
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── recordTokens ─────────────────────────────────────────────────────────────

describe("recordTokens", () => {
  it("trips when tokenCount exceeds maxTokens", async () => {
    const cb = makeCb({ thresholds: { maxTokens: 10 } });
    cb.recordTokens(11);
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain("session-cb");
  });

  it("does not trip at exactly maxTokens", async () => {
    const cb = makeCb({ thresholds: { maxTokens: 10 } });
    cb.recordTokens(10); // exactly at limit — not >, so no trip
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(true);
  });

  it("accumulates costUsd", () => {
    const cb = makeCb({ thresholds: { maxCostUsd: 5 } });
    cb.recordTokens(10, 1.5);
    cb.recordTokens(10, 2.0);
    const snap = cb.snapshot();
    expect(snap.estimatedCostUsd).toBeCloseTo(3.5);
  });

  it("trips when costUsd exceeds maxCostUsd", async () => {
    const cb = makeCb({ thresholds: { maxCostUsd: 1.0 } });
    cb.recordTokens(0, 1.1);
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
  });
});

// ─── recordError ─────────────────────────────────────────────────────────────

describe("recordError", () => {
  it("trips when consecutiveErrors reaches maxConsecutiveErrors", async () => {
    const cb = makeCb({ thresholds: { maxConsecutiveErrors: 2 } });
    cb.recordError();
    cb.recordError();
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
  });

  it("does not trip below maxConsecutiveErrors", async () => {
    const cb = makeCb({ thresholds: { maxConsecutiveErrors: 3 } });
    cb.recordError();
    cb.recordError();
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(true);
  });

  it("recordSuccess resets consecutiveErrors", async () => {
    const cb = makeCb({ thresholds: { maxConsecutiveErrors: 3 } });
    cb.recordError();
    cb.recordError();
    cb.recordSuccess(); // resets counter
    cb.recordError();
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(true);
  });
});

// ─── recordAction ─────────────────────────────────────────────────────────────

describe("recordAction", () => {
  it("trips when actionCount exceeds maxActionCount", async () => {
    const cb = makeCb({ thresholds: { maxActionCount: 3 } });
    cb.recordAction();
    cb.recordAction();
    cb.recordAction();
    cb.recordAction(); // 4 > 3
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
  });
});

// ─── elapsed time ────────────────────────────────────────────────────────────

describe("elapsed time threshold", () => {
  it("trips when elapsed > maxElapsedMs", async () => {
    let t = 0;
    const cb = makeCb({
      thresholds: { maxElapsedMs: 1000 },
      _now: () => {
        t += 100;
        return t;
      },
    });
    // Advance clock past threshold via check (which calls _now once for elapsed)
    // advance 12 times × 100ms = 1200ms total → well past 1000ms
    for (let i = 0; i < 12; i++) {
      await cb.check(CTX);
    }
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
  });
});

// ─── open state (resetAfterMs) ────────────────────────────────────────────────

describe("open state", () => {
  it("returns proceed:false while within resetAfterMs", async () => {
    let t = 0;
    const cb = makeCb({
      thresholds: { maxTokens: 5 },
      resetAfterMs: 10_000,
      _now: () => t,
    });
    cb.recordTokens(6); // trip
    t = 5_000; // still within resetAfterMs
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(false);
    expect(result.reason).toContain("OPEN");
  });

  it("transitions to half-open after resetAfterMs", async () => {
    let t = 0;
    const cb = makeCb({
      thresholds: { maxTokens: 5 },
      resetAfterMs: 1_000,
      _now: () => t,
    });
    cb.recordTokens(6); // trip
    t = 1_001; // past resetAfterMs
    const result = await cb.check(CTX);
    expect(result.proceed).toBe(true);
  });
});

// ─── half-open state ─────────────────────────────────────────────────────────

describe("half-open state", () => {
  it("recordSuccess transitions to closed", async () => {
    let t = 0;
    const cb = makeCb({
      thresholds: { maxTokens: 5 },
      resetAfterMs: 1_000,
      _now: () => t,
    });
    cb.recordTokens(6); // trip
    t = 1_001; // → half-open
    await cb.check(CTX); // probe allowed
    cb.recordSuccess(); // → closed
    const snap = cb.snapshot();
    expect(snap.state).toBe("closed");
  });

  it("recordError during probe re-trips to open", async () => {
    let t = 0;
    const cb = makeCb({
      thresholds: { maxTokens: 5 },
      resetAfterMs: 1_000,
      _now: () => t,
    });
    cb.recordTokens(6); // trip
    t = 1_001; // → half-open
    await cb.check(CTX); // probe
    cb.recordError(); // re-trip
    const snap = cb.snapshot();
    expect(snap.state).toBe("open");
  });
});

// ─── reset ────────────────────────────────────────────────────────────────────

describe("reset", () => {
  it("clears all state back to closed", () => {
    const cb = makeCb({ thresholds: { maxTokens: 5 } });
    cb.recordTokens(6);
    cb.reset();
    const snap = cb.snapshot();
    expect(snap.state).toBe("closed");
    expect(snap.tokenCount).toBe(0);
    expect(snap.consecutiveErrors).toBe(0);
    expect(snap.actionCount).toBe(0);
    expect(snap.estimatedCostUsd).toBe(0);
    expect(snap.tripReason).toBeUndefined();
  });
});

// ─── onTrip callback ──────────────────────────────────────────────────────────

describe("onTrip callback", () => {
  it("is invoked when first trip occurs", () => {
    const onTrip = vi.fn();
    const cb = makeCb({ thresholds: { maxTokens: 5 }, onTrip });
    cb.recordTokens(6);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("is not invoked again on duplicate trip (idempotent)", () => {
    const onTrip = vi.fn();
    const cb = makeCb({ thresholds: { maxTokens: 5 }, onTrip });
    cb.recordTokens(6);
    cb.recordTokens(10); // already open — no-op
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("snapshot passed to onTrip reflects breached state", () => {
    const onTrip = vi.fn();
    const cb = makeCb({ thresholds: { maxTokens: 5 }, onTrip });
    cb.recordTokens(6);
    const snap = onTrip.mock.calls[0][0];
    expect(snap.state).toBe("open");
    expect(snap.tokenCount).toBe(6);
  });
});

// ─── snapshot ─────────────────────────────────────────────────────────────────

describe("snapshot", () => {
  it("reflects current counter values", () => {
    const cb = makeCb();
    cb.recordTokens(20, 0.5);
    cb.recordAction();
    cb.recordAction();
    const snap = cb.snapshot();
    expect(snap.tokenCount).toBe(20);
    expect(snap.actionCount).toBe(2);
    expect(snap.estimatedCostUsd).toBeCloseTo(0.5);
    expect(snap.state).toBe("closed");
  });
});
