/**
 * Tests for packages/agent-sdk/src/compute/strategies/two-phase-orient.ts
 *
 * Coverage:
 *   runTwoPhaseOrient — success path, orient failure → TwoPhaseOrientError(orient),
 *                       act failure with retries → TwoPhaseOrientError(act),
 *                       act succeeds on retry, maxActRetries=0 (no retries),
 *                       retriesUsed count
 *   TwoPhaseOrientError — name, phase, retriesUsed, cause
 *
 * Ref: test coverage for agent-sdk/compute/strategies/two-phase-orient.ts (no prior tests)
 */

import { describe, expect, it, vi } from "vitest";
import {
  TwoPhaseOrientError,
  runTwoPhaseOrient,
} from "../src/compute/strategies/two-phase-orient.js";

describe("runTwoPhaseOrient", () => {
  it("returns orientation, result, and retriesUsed=0 on happy path", async () => {
    const { orientation, result, retriesUsed } = await runTwoPhaseOrient(
      {
        orient: async (ctx: { x: number }) => ({ signal: ctx.x * 2 }),
        act: async (o) => `done:${o.signal}`,
      },
      { x: 21 },
    );
    expect(orientation).toEqual({ signal: 42 });
    expect(result).toBe("done:42");
    expect(retriesUsed).toBe(0);
  });

  it("throws TwoPhaseOrientError(orient) when Phase 1 fails", async () => {
    await expect(
      runTwoPhaseOrient(
        {
          orient: async () => {
            throw new Error("no signals");
          },
          act: async () => "unreachable",
        },
        {},
      ),
    ).rejects.toMatchObject({
      name: "TwoPhaseOrientError",
      phase: "orient",
      retriesUsed: 0,
    });
  });

  it("TwoPhaseOrientError carries the original cause", async () => {
    const cause = new Error("root cause");
    let thrown: TwoPhaseOrientError | undefined;
    try {
      await runTwoPhaseOrient(
        {
          orient: async () => {
            throw cause;
          },
          act: async () => "x",
        },
        {},
      );
    } catch (e) {
      thrown = e as TwoPhaseOrientError;
    }
    expect(thrown?.cause).toBe(cause);
  });

  it("throws TwoPhaseOrientError(act) when act exhausts retries", async () => {
    await expect(
      runTwoPhaseOrient(
        {
          orient: async () => ({ ok: true }),
          act: async () => {
            throw new Error("act always fails");
          },
        },
        {},
        // default maxActRetries = 1 → 2 attempts
      ),
    ).rejects.toMatchObject({
      name: "TwoPhaseOrientError",
      phase: "act",
    });
  });

  it("act phase retries up to maxActRetries times", async () => {
    let attempts = 0;
    await expect(
      runTwoPhaseOrient(
        {
          orient: async () => ({}),
          act: async () => {
            attempts++;
            throw new Error("fail");
          },
          maxActRetries: 3,
        },
        {},
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(4); // 1 initial + 3 retries
  });

  it("reports retriesUsed=N when act succeeds on Nth retry", async () => {
    let attempt = 0;
    const { retriesUsed } = await runTwoPhaseOrient(
      {
        orient: async () => ({}),
        act: async () => {
          attempt++;
          if (attempt < 3) throw new Error("not yet");
          return "ok";
        },
        maxActRetries: 3,
      },
      {},
    );
    expect(retriesUsed).toBe(2); // succeeded on attempt 3 → 2 retries consumed
  });

  it("maxActRetries=0 means exactly one attempt (no retries)", async () => {
    let attempts = 0;
    await expect(
      runTwoPhaseOrient(
        {
          orient: async () => ({}),
          act: async () => {
            attempts++;
            throw new Error("fail");
          },
          maxActRetries: 0,
        },
        {},
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("Phase 1 is not called again on Phase 2 retries", async () => {
    const orientSpy = vi.fn().mockResolvedValue({ data: "fixed" });
    let actAttempts = 0;
    await runTwoPhaseOrient(
      {
        orient: orientSpy,
        act: async () => {
          actAttempts++;
          if (actAttempts < 2) throw new Error("try again");
          return "done";
        },
        maxActRetries: 2,
      },
      {},
    );
    expect(orientSpy).toHaveBeenCalledOnce();
    expect(actAttempts).toBe(2);
  });
});

describe("TwoPhaseOrientError", () => {
  it("has name=TwoPhaseOrientError", () => {
    const e = new TwoPhaseOrientError("orient", new Error("x"), 0, "msg");
    expect(e.name).toBe("TwoPhaseOrientError");
  });

  it("exposes phase, cause, retriesUsed", () => {
    const cause = new Error("root");
    const e = new TwoPhaseOrientError("act", cause, 3, "msg");
    expect(e.phase).toBe("act");
    expect(e.cause).toBe(cause);
    expect(e.retriesUsed).toBe(3);
  });

  it("is instanceof Error", () => {
    expect(new TwoPhaseOrientError("orient", null, 0, "msg")).toBeInstanceOf(Error);
  });
});
