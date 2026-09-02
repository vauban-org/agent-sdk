/**
 * tests/compute-single-shot.test.ts
 *
 * Unit tests for the single-shot compute strategy.
 */

import { describe, expect, it } from "vitest";
import { singleShotStrategy } from "../src/compute/strategies/single-shot.js";
import type { ComputeContext } from "../src/compute/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEchoGenerator<T>(): (input: T, _ctx: ComputeContext) => Promise<T> {
  return async (input) => input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("singleShotStrategy", () => {
  it("passes input through unchanged", async () => {
    const strategy = singleShotStrategy<string, string>();
    const generator = makeEchoGenerator<string>();

    const { result } = await strategy.run("hello", generator);

    expect(result).toBe("hello");
  });

  it("returns correct metadata: strategy name, candidates, calls, latency", async () => {
    const strategy = singleShotStrategy<number, number>();
    const generator = makeEchoGenerator<number>();

    const { metadata } = await strategy.run(42, generator);

    expect(metadata.strategy).toBe("single-shot");
    expect(metadata.candidates).toBe(1);
    expect(metadata.verifier_scores).toEqual([]);
    expect(metadata.cost.calls).toBe(1);
    expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("propagates AbortSignal: generator sees an aborted signal", async () => {
    const strategy = singleShotStrategy<string, string>();

    const controller = new AbortController();
    controller.abort();

    const generator = async (input: string, ctx: ComputeContext): Promise<string> => {
      if (ctx.signal?.aborted) {
        throw new Error("aborted");
      }
      return input;
    };

    await expect(strategy.run("ignored", generator, { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });

  it("propagates generator errors (rejection bubbles up)", async () => {
    const strategy = singleShotStrategy<string, string>();

    const generator = async (_input: string, _ctx: ComputeContext): Promise<string> => {
      throw new Error("generator failure");
    };

    await expect(strategy.run("anything", generator)).rejects.toThrow("generator failure");
  });

  it("strategy name is always 'single-shot'", () => {
    const strategy = singleShotStrategy<unknown, unknown>();
    expect(strategy.name).toBe("single-shot");
  });

  it("works with object input/output (passes reference through)", async () => {
    const strategy = singleShotStrategy<{ x: number }, { x: number }>();
    const input = { x: 42 };
    const { result } = await strategy.run(input, async (v) => v);
    expect(result).toBe(input);
  });

  it("measures latency_ms as a non-negative number", async () => {
    const strategy = singleShotStrategy<string, string>();
    const { metadata } = await strategy.run("hi", async (v) => v);
    expect(metadata.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof metadata.latency_ms).toBe("number");
  });
});
