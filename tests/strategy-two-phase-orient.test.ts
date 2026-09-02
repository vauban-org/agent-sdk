/**
 * tests/strategy-two-phase-orient.test.ts
 *
 * Unit tests for the TwoPhaseOrient pattern.
 */

import { describe, expect, it, vi } from "vitest";
import {
  TwoPhaseOrientError,
  runTwoPhaseOrient,
} from "../src/compute/strategies/two-phase-orient.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ctx = { userId: string };
type Orient = { signals: string[] };
type Result = { decision: string };

function makeCtx(id = "u-1"): Ctx {
  return { userId: id };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTwoPhaseOrient", () => {
  it("happy path — returns orientation, result, and retriesUsed=0", async () => {
    const ctx = makeCtx();

    const { orientation, result, retriesUsed } = await runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async (c) => ({ signals: [`signal-for-${c.userId}`] }),
        act: async (o, _c) => ({ decision: `based-on-${o.signals[0]}` }),
      },
      ctx,
    );

    expect(orientation).toEqual({ signals: ["signal-for-u-1"] });
    expect(result).toEqual({ decision: "based-on-signal-for-u-1" });
    expect(retriesUsed).toBe(0);
  });

  it("Phase 1 error — throws TwoPhaseOrientError with phase=orient, act is never called", async () => {
    const actFn = vi.fn();

    const promise = runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async () => {
          throw new Error("orient-boom");
        },
        act: actFn,
      },
      makeCtx(),
    );

    await expect(promise).rejects.toThrow(TwoPhaseOrientError);
    await expect(promise).rejects.toMatchObject({
      phase: "orient",
      retriesUsed: 0,
      message: expect.stringContaining("orient-boom"),
    });
    expect(actFn).not.toHaveBeenCalled();
  });

  it("Phase 2 retry success — succeeds on second attempt, retriesUsed=1", async () => {
    let callCount = 0;

    const { retriesUsed, result } = await runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async () => ({ signals: ["ok"] }),
        act: async () => {
          callCount++;
          if (callCount === 1) throw new Error("transient");
          return { decision: "recovered" };
        },
        maxActRetries: 2,
      },
      makeCtx(),
    );

    expect(result).toEqual({ decision: "recovered" });
    expect(retriesUsed).toBe(1);
    expect(callCount).toBe(2);
  });

  it("Phase 2 exhausted retries — throws TwoPhaseOrientError with phase=act", async () => {
    const actFn = vi.fn().mockRejectedValue(new Error("act-always-fails"));

    const promise = runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async () => ({ signals: ["x"] }),
        act: actFn,
        maxActRetries: 2,
      },
      makeCtx(),
    );

    await expect(promise).rejects.toThrow(TwoPhaseOrientError);
    await expect(promise).rejects.toMatchObject({
      phase: "act",
      retriesUsed: 2,
      message: expect.stringContaining("act-always-fails"),
    });
    // 1 initial attempt + 2 retries = 3 total calls
    expect(actFn).toHaveBeenCalledTimes(3);
  });

  it("context passthrough — both orient and act receive the original context", async () => {
    const ctx = makeCtx("user-42");
    const orientCtxCapture: Ctx[] = [];
    const actCtxCapture: Ctx[] = [];

    await runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async (c) => {
          orientCtxCapture.push(c);
          return { signals: [] };
        },
        act: async (_o, c) => {
          actCtxCapture.push(c);
          return { decision: "ok" };
        },
      },
      ctx,
    );

    expect(orientCtxCapture).toHaveLength(1);
    expect(orientCtxCapture[0]).toBe(ctx);
    expect(actCtxCapture).toHaveLength(1);
    expect(actCtxCapture[0]).toBe(ctx);
  });

  it("maxActRetries=0 — no retries, throws immediately on first act failure", async () => {
    const actFn = vi.fn().mockRejectedValue(new Error("no-retry"));

    const promise = runTwoPhaseOrient<Ctx, Orient, Result>(
      {
        orient: async () => ({ signals: [] }),
        act: actFn,
        maxActRetries: 0,
      },
      makeCtx(),
    );

    await expect(promise).rejects.toMatchObject({
      phase: "act",
      retriesUsed: 0,
    });
    expect(actFn).toHaveBeenCalledTimes(1);
  });

  it("negative maxActRetries treated as 0", async () => {
    const actFn = vi.fn().mockRejectedValue(new Error("neg-retry"));

    await expect(
      runTwoPhaseOrient<Ctx, Orient, Result>(
        {
          orient: async () => ({ signals: [] }),
          act: actFn,
          maxActRetries: -5,
        },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ phase: "act", retriesUsed: 0 });

    expect(actFn).toHaveBeenCalledTimes(1);
  });

  it("orient receives context identity (same reference, not copy)", async () => {
    const ctx = { userId: "ref-check", extra: { nested: true } };
    let captured: typeof ctx | undefined;

    await runTwoPhaseOrient(
      {
        orient: async (c) => {
          captured = c as typeof ctx;
          return {};
        },
        act: async () => "done",
      },
      ctx,
    );

    expect(captured).toBe(ctx);
  });
});
