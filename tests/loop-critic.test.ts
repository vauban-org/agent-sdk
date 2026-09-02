/**
 * tests/loop-critic.test.ts
 *
 * Direct unit coverage for `criticLoop` (@alpha, CRITIC ICLR 2024 arXiv:2305.11738),
 * the general tool-grounded self-correction primitive.
 *
 * The verifier is a deterministic oracle (never LLM introspection); the reviser is
 * a caller-supplied regenerator that receives the tool-grounded discrepancy.
 */

import { describe, expect, it, vi } from "vitest";
import { type CriticVerifier, criticLoop } from "../src/loop/critic.js";

// Deterministic tool-grounded oracle: accept strings of at least `min` chars.
const minLength =
  (min: number): CriticVerifier<string> =>
  async (output) =>
    output.length >= min
      ? { ok: true }
      : { ok: false, discrepancy: `too short: ${output.length} < ${min}` };

describe("criticLoop", () => {
  it("returns rounds=0 and the initial output when it already passes verification", async () => {
    const revise = vi.fn(async (s: string) => s);
    const r = await criticLoop("already-long-enough", minLength(5), revise);

    expect(r.verified).toBe(true);
    expect(r.rounds).toBe(0);
    expect(r.output).toBe("already-long-enough");
    expect(r.history).toHaveLength(0);
    expect(revise).not.toHaveBeenCalled();
  });

  it("recovers in one round and feeds the tool-grounded discrepancy to the reviser", async () => {
    const revise = vi.fn(async () => "padded-to-pass");
    const r = await criticLoop("hi", minLength(10), revise);

    expect(r.verified).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.output).toBe("padded-to-pass");
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toEqual({
      round: 1,
      discrepancy: "too short: 2 < 10",
    });
    // The reviser receives (currentOutput, discrepancy), not the output alone.
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0][0]).toBe("hi");
    expect(revise.mock.calls[0][1]).toBe("too short: 2 < 10");
  });

  it("fails closed (verified=false) and returns the last revision when maxRounds is exhausted", async () => {
    const revise = vi.fn(async () => "x"); // never long enough
    const r = await criticLoop("x", minLength(10), revise, 2);

    expect(r.verified).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.output).toBe("x");
    expect(r.history).toHaveLength(2);
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it("maxRounds=0 verifies once without ever revising (passing case)", async () => {
    const revise = vi.fn(async (s: string) => s);
    const r = await criticLoop("long-enough", minLength(5), revise, 0);

    expect(r.verified).toBe(true);
    expect(r.rounds).toBe(0);
    expect(r.history).toHaveLength(0);
    expect(revise).not.toHaveBeenCalled();
  });

  it("maxRounds=0 fails closed without revising when the initial output is invalid", async () => {
    const revise = vi.fn(async (s: string) => s);
    const r = await criticLoop("no", minLength(10), revise, 0);

    expect(r.verified).toBe(false);
    expect(r.rounds).toBe(0);
    expect(r.output).toBe("no");
    expect(revise).not.toHaveBeenCalled();
  });

  it("throws TypeError when maxRounds is negative or non-integer", async () => {
    const revise = async (s: string) => s;
    await expect(criticLoop("x", minLength(1), revise, -1)).rejects.toThrow(TypeError);
    await expect(criticLoop("x", minLength(1), revise, 1.5)).rejects.toThrow(TypeError);
  });
});
