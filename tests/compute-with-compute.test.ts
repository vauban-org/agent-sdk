/**
 * tests/compute-with-compute.test.ts
 *
 * Sprint A — TDD edge cases for the `withCompute()` public API.
 */

import { describe, expect, it, vi } from "vitest";
import { singleShotStrategy } from "../src/compute/strategies/single-shot.js";
import type { ComputeContext, Strategy, StrategyResult } from "../src/compute/types.js";
import {
  BudgetExhaustedError,
  DeadlineExceededError,
  InvalidStrategyError,
  withCompute,
} from "../src/compute/with-compute.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withCompute()", () => {
  it("happy path: single-shot strategy returns StrategyResult and calls generator once", async () => {
    const generator = vi.fn(async (input: string, _ctx: ComputeContext) => `out:${input}`);

    const out = await withCompute<string, string>("hello", {
      strategy: singleShotStrategy<string, string>(),
      generator,
    });

    expect(generator).toHaveBeenCalledTimes(1);
    expect(out.result).toBe("out:hello");
    expect(out.metadata.strategy).toBe("single-shot");
    expect(out.metadata.candidates).toBe(1);
    expect(out.metadata.cost.calls).toBe(1);
    expect(out.metadata.verifier_scores).toEqual([]);
    expect(out.metadata.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("budget.maxCalls === 0 → throws BudgetExhaustedError BEFORE invoking generator", async () => {
    const generator = vi.fn(async (i: string) => i);

    await expect(
      withCompute<string, string>("x", {
        strategy: singleShotStrategy<string, string>(),
        generator,
        budget: { maxCalls: 0 },
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);

    expect(generator).not.toHaveBeenCalled();
  });

  it("deadline already past → throws DeadlineExceededError BEFORE invoking generator", async () => {
    const generator = vi.fn(async (i: string) => i);

    await expect(
      withCompute<string, string>("x", {
        strategy: singleShotStrategy<string, string>(),
        generator,
        deadline: Date.now() - 1000,
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);

    expect(generator).not.toHaveBeenCalled();
  });

  it("missing/null strategy → throws InvalidStrategyError (runtime guard for JS callers)", async () => {
    const generator = vi.fn(async (i: string) => i);

    await expect(
      withCompute<string, string>("x", {
        strategy: null as unknown as Strategy<string, string>,
        generator,
      }),
    ).rejects.toBeInstanceOf(InvalidStrategyError);

    await expect(
      withCompute<string, string>("x", {
        strategy: undefined as unknown as Strategy<string, string>,
        generator,
      }),
    ).rejects.toBeInstanceOf(InvalidStrategyError);

    expect(generator).not.toHaveBeenCalled();
  });

  it("AbortSignal already aborted → does not call generator, throws AbortError", async () => {
    const generator = vi.fn(async (i: string) => i);
    const controller = new AbortController();
    controller.abort();

    await expect(
      withCompute<string, string>("x", {
        strategy: singleShotStrategy<string, string>(),
        generator,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(generator).not.toHaveBeenCalled();
  });

  it("generator rejection bubbles up unchanged", async () => {
    const boom = new Error("generator boom");
    const generator = async (_i: string, _ctx: ComputeContext): Promise<string> => {
      throw boom;
    };

    await expect(
      withCompute<string, string>("x", {
        strategy: singleShotStrategy<string, string>(),
        generator,
      }),
    ).rejects.toBe(boom);
  });

  it("metadata.strategy reflects the actual strategy.name (trust the strategy)", async () => {
    const customStrategy: Strategy<string, string> = {
      name: "custom-strategy",
      async run(input, generator, ctx): Promise<StrategyResult<string>> {
        const result = await generator(input, ctx ?? {});
        return {
          result,
          metadata: {
            strategy: "custom-strategy",
            candidates: 1,
            verifier_scores: [0.9],
            cost: { calls: 1 },
            latency_ms: 0,
          },
        };
      },
    };

    const out = await withCompute<string, string>("y", {
      strategy: customStrategy,
      generator: async (i) => i,
    });

    expect(out.metadata.strategy).toBe("custom-strategy");
    expect(out.metadata.verifier_scores).toEqual([0.9]);
  });

  it("forwards AbortSignal to the strategy via ComputeContext", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;

    const generator = async (input: string, ctx: ComputeContext): Promise<string> => {
      seenSignal = ctx.signal;
      return input;
    };

    await withCompute<string, string>("z", {
      strategy: singleShotStrategy<string, string>(),
      generator,
      signal: controller.signal,
    });

    expect(seenSignal).toBe(controller.signal);
  });

  it("budget.maxCalls > 0 does not block (cap honoured by future strategies)", async () => {
    const generator = vi.fn(async (i: string) => i);

    const out = await withCompute<string, string>("ok", {
      strategy: singleShotStrategy<string, string>(),
      generator,
      budget: { maxCalls: 5 },
    });

    expect(out.result).toBe("ok");
    expect(generator).toHaveBeenCalledTimes(1);
  });
});
