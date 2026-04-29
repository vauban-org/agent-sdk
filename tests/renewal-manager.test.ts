/**
 * RenewalManager tests — 80% threshold, debounce, budget preservation.
 */

import { describe, expect, it, vi } from "vitest";
import {
  RenewalManager,
  type CapabilityGate,
  type CapabilityGateVerdict,
} from "../src/index.js";

interface FakeGate extends CapabilityGate {
  current: { token: string; issuedAt: number; expiresAt: number };
  budgetUsedSeen: number[];
  rotations: number;
}

function makeGate(initial: {
  token: string;
  issuedAt: number;
  expiresAt: number;
}): FakeGate {
  const state: FakeGate = {
    current: { ...initial },
    budgetUsedSeen: [],
    rotations: 0,
    verify(call): CapabilityGateVerdict {
      this.budgetUsedSeen.push(call.budgetUsed);
      return { allowed: true };
    },
    getExpiresAt() {
      return this.current.expiresAt;
    },
    getIssuedAt() {
      return this.current.issuedAt;
    },
    rotateToken(newTokenB64: string, newExpiresAt: number) {
      const newIssuedAt = newExpiresAt - 3600;
      this.current = {
        token: newTokenB64,
        issuedAt: newIssuedAt,
        expiresAt: newExpiresAt,
      };
      this.rotations += 1;
    },
  };
  return state;
}

describe("RenewalManager", () => {
  it("does NOT renew before the 80% threshold", async () => {
    const gate = makeGate({ token: "tok0", issuedAt: 1000, expiresAt: 2000 });
    const reissue = vi.fn();
    const m = new RenewalManager({
      gate,
      reissue,
      now: () => 1500, // 50% elapsed
    });
    const fired = await m.maybeRenew();
    expect(fired).toBe(false);
    expect(reissue).not.toHaveBeenCalled();
    expect(gate.rotations).toBe(0);
  });

  it("renews at exactly 80% elapsed", async () => {
    const gate = makeGate({ token: "tok0", issuedAt: 1000, expiresAt: 2000 });
    const reissue = vi.fn(async () => ({
      token: "tok1",
      issuedAtEpochSeconds: 1800,
      expiresAtEpochSeconds: 2800,
    }));
    const m = new RenewalManager({
      gate,
      reissue,
      now: () => 1800, // 80% elapsed
    });
    const fired = await m.maybeRenew();
    expect(fired).toBe(true);
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(gate.rotations).toBe(1);
    expect(gate.current.token).toBe("tok1");
    expect(gate.current.expiresAt).toBe(2800);
  });

  it("debounces concurrent renewal calls (single re-issue)", async () => {
    const gate = makeGate({ token: "tok0", issuedAt: 1000, expiresAt: 2000 });
    let resolveReissue!: (v: {
      token: string;
      issuedAtEpochSeconds: number;
      expiresAtEpochSeconds: number;
    }) => void;
    const reissue = vi.fn(
      () =>
        new Promise<{
          token: string;
          issuedAtEpochSeconds: number;
          expiresAtEpochSeconds: number;
        }>((r) => {
          resolveReissue = r;
        }),
    );
    const m = new RenewalManager({
      gate,
      reissue,
      now: () => 1900, // 90% elapsed
    });
    const a = m.maybeRenew();
    const b = m.maybeRenew();
    const c = m.maybeRenew();
    resolveReissue({
      token: "tok1",
      issuedAtEpochSeconds: 1900,
      expiresAtEpochSeconds: 2900,
    });
    await Promise.all([a, b, c]);
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(gate.rotations).toBe(1);
  });

  it("budgetUsed is preserved across renewal (not reset)", async () => {
    const gate = makeGate({ token: "tok0", issuedAt: 1000, expiresAt: 2000 });
    const reissue = vi.fn(async () => ({
      token: "tok1",
      issuedAtEpochSeconds: 1800,
      expiresAtEpochSeconds: 2800,
    }));
    const m = new RenewalManager({
      gate,
      reissue,
      now: () => 1800,
    });

    // Simulate the loop accounting calls before & after renewal.
    await gate.verify({ toolName: "x", budgetUsed: 0.1 });
    await gate.verify({ toolName: "x", budgetUsed: 0.2 });
    await m.maybeRenew();
    await gate.verify({ toolName: "x", budgetUsed: 0.3 });
    expect(gate.budgetUsedSeen).toEqual([0.1, 0.2, 0.3]); // never reset
  });

  it("returns false when the gate cannot expose expiry", async () => {
    const minimal: CapabilityGate = {
      verify: () => ({ allowed: true }),
    };
    const reissue = vi.fn();
    const m = new RenewalManager({
      gate: minimal,
      reissue,
      now: () => 9999,
    });
    expect(await m.maybeRenew()).toBe(false);
    expect(reissue).not.toHaveBeenCalled();
  });

  it("rejects invalid thresholdFraction at construction", () => {
    expect(
      () =>
        new RenewalManager({
          gate: { verify: () => ({ allowed: true }) },
          reissue: async () => ({
            token: "x",
            issuedAtEpochSeconds: 0,
            expiresAtEpochSeconds: 1,
          }),
          thresholdFraction: 0,
        }),
    ).toThrow();
    expect(
      () =>
        new RenewalManager({
          gate: { verify: () => ({ allowed: true }) },
          reissue: async () => ({
            token: "x",
            issuedAtEpochSeconds: 0,
            expiresAtEpochSeconds: 1,
          }),
          thresholdFraction: 1,
        }),
    ).toThrow();
  });
});
