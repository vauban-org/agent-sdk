/**
 * Tests for:
 *   agent-sdk/src/proof/fallback-adapter.ts
 *
 * Coverage:
 *   FallbackAdapter constructor — empty array rejection, single/multiple adapters
 *   AllAdaptersFailedError — AggregateError subclass, name, errors array, message
 *   request() — first-wins cascade, all-fail aggregation, error preservation
 *   verify() — tsaUrl fast path, full fallback scan, all-invalid returns false
 */

import { describe, expect, it, vi } from "vitest";
import type { TimestampPort } from "../src/ports/timestamp.js";
import { AllAdaptersFailedError, FallbackAdapter } from "../src/proof/fallback-adapter.js";
import type { SignedReceipt } from "../src/trace/schema.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReceipt(tsaUrl: string): SignedReceipt {
  return {
    tsa: tsaUrl,
    timestamp: new Date().toISOString(),
    signature: "c2lnbmF0dXJl",
    algorithm: "sha-256",
    hashedMessage: "abc123",
  };
}

function makeAdapter(
  opts: {
    tsaUrl?: string;
    requestResult?: Promise<SignedReceipt> | Error;
    verifyResult?: Promise<{ valid: boolean; reason?: string }> | Error;
  } = {},
): TimestampPort & { tsaUrl?: string } {
  const defaultReceipt = makeReceipt(opts.tsaUrl ?? "https://tsa.example.com");
  return {
    tsaUrl: opts.tsaUrl,
    request: vi
      .fn()
      .mockImplementation(() =>
        opts.requestResult instanceof Error
          ? Promise.reject(opts.requestResult)
          : (opts.requestResult ?? Promise.resolve(defaultReceipt)),
      ),
    verify: vi
      .fn()
      .mockImplementation(() =>
        opts.verifyResult instanceof Error
          ? Promise.reject(opts.verifyResult)
          : (opts.verifyResult ?? Promise.resolve({ valid: true })),
      ),
  };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("FallbackAdapter — constructor", () => {
  it("throws when passed an empty adapters array", () => {
    expect(() => new FallbackAdapter([])).toThrow("FallbackAdapter requires at least one adapter");
  });

  it("accepts a single adapter without throwing", () => {
    const adapter = makeAdapter();
    expect(() => new FallbackAdapter([adapter])).not.toThrow();
  });

  it("accepts multiple adapters without throwing", () => {
    const adapters = [makeAdapter(), makeAdapter(), makeAdapter()];
    expect(() => new FallbackAdapter(adapters)).not.toThrow();
  });
});

// ─── AllAdaptersFailedError ───────────────────────────────────────────────────

describe("AllAdaptersFailedError", () => {
  it("is an instance of AggregateError", () => {
    const err = new AllAdaptersFailedError([new Error("x")]);
    expect(err).toBeInstanceOf(AggregateError);
  });

  it("has the name property set to 'AllAdaptersFailedError'", () => {
    const err = new AllAdaptersFailedError([new Error("x")]);
    expect(err.name).toBe("AllAdaptersFailedError");
  });

  it("exposes the individual errors on the errors array", () => {
    const e1 = new Error("adapter-1 failed");
    const e2 = new Error("adapter-2 failed");
    const err = new AllAdaptersFailedError([e1, e2]);
    expect(err.errors).toHaveLength(2);
    expect(err.errors[0]).toBe(e1);
    expect(err.errors[1]).toBe(e2);
  });

  it("preserves a custom message", () => {
    const err = new AllAdaptersFailedError([], "custom failure message");
    expect(err.message).toBe("custom failure message");
  });
});

// ─── request() — success cases ───────────────────────────────────────────────

describe("FallbackAdapter.request() — success", () => {
  it("returns the result from a single succeeding adapter", async () => {
    const receipt = makeReceipt("https://tsa.example.com");
    const adapter = makeAdapter({
      requestResult: Promise.resolve(receipt),
    });
    const fa = new FallbackAdapter([adapter]);
    const result = await fa.request("hash123");
    expect(result).toBe(receipt);
  });

  it("skips a failing first adapter and returns the second adapter's result", async () => {
    const receipt = makeReceipt("https://tsa-b.example.com");
    const adapterA = makeAdapter({ requestResult: new Error("A down") });
    const adapterB = makeAdapter({ requestResult: Promise.resolve(receipt) });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const result = await fa.request("hash123");
    expect(result).toBe(receipt);
  });

  it("returns the third adapter's result when the first two fail", async () => {
    const receipt = makeReceipt("https://tsa-c.example.com");
    const adapterA = makeAdapter({ requestResult: new Error("A down") });
    const adapterB = makeAdapter({ requestResult: new Error("B down") });
    const adapterC = makeAdapter({ requestResult: Promise.resolve(receipt) });
    const fa = new FallbackAdapter([adapterA, adapterB, adapterC]);
    const result = await fa.request("hash123");
    expect(result).toBe(receipt);
  });

  it("does not call subsequent adapters when the first succeeds", async () => {
    const adapterA = makeAdapter();
    const adapterB = makeAdapter();
    const fa = new FallbackAdapter([adapterA, adapterB]);
    await fa.request("hash123");
    expect(adapterA.request).toHaveBeenCalledOnce();
    expect(adapterB.request).not.toHaveBeenCalled();
  });
});

// ─── request() — failure cases ───────────────────────────────────────────────

describe("FallbackAdapter.request() — all fail", () => {
  it("throws AllAdaptersFailedError when all adapters fail", async () => {
    const adapterA = makeAdapter({ requestResult: new Error("A down") });
    const adapterB = makeAdapter({ requestResult: new Error("B down") });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    await expect(fa.request("hash123")).rejects.toBeInstanceOf(AllAdaptersFailedError);
  });

  it("includes one error per adapter in AllAdaptersFailedError.errors", async () => {
    const adapterA = makeAdapter({ requestResult: new Error("A down") });
    const adapterB = makeAdapter({ requestResult: new Error("B down") });
    const adapterC = makeAdapter({ requestResult: new Error("C down") });
    const fa = new FallbackAdapter([adapterA, adapterB, adapterC]);
    const err = await fa.request("hash123").catch((e) => e);
    expect(err).toBeInstanceOf(AllAdaptersFailedError);
    expect((err as AllAdaptersFailedError).errors).toHaveLength(3);
  });

  it("preserves error messages from each adapter in AggregateError.errors", async () => {
    const adapterA = makeAdapter({
      requestResult: new Error("adapter A failure"),
    });
    const adapterB = makeAdapter({
      requestResult: new Error("adapter B failure"),
    });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const err = await fa.request("hash123").catch((e) => e as AllAdaptersFailedError);
    expect(err.errors[0].message).toBe("adapter A failure");
    expect(err.errors[1].message).toBe("adapter B failure");
  });
});

// ─── verify() — success cases ────────────────────────────────────────────────

describe("FallbackAdapter.verify() — success", () => {
  it("returns { valid: true } when a single adapter verifies successfully", async () => {
    const adapter = makeAdapter({
      verifyResult: Promise.resolve({ valid: true }),
    });
    const fa = new FallbackAdapter([adapter]);
    const receipt = makeReceipt("https://tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(true);
  });

  it("skips a throwing first adapter and returns valid=true from the second", async () => {
    const adapterA = makeAdapter({
      verifyResult: new Error("verify threw"),
    });
    const adapterB = makeAdapter({
      verifyResult: Promise.resolve({ valid: true }),
    });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const receipt = makeReceipt("https://tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(true);
  });
});

// ─── verify() — tsaUrl fast path ─────────────────────────────────────────────

describe("FallbackAdapter.verify() — tsaUrl fast path", () => {
  it("uses the adapter whose tsaUrl matches receipt.tsa", async () => {
    const tsaUrl = "https://tsa-specific.example.com";
    const adapterA = makeAdapter({
      tsaUrl: "https://tsa-other.example.com",
      verifyResult: Promise.resolve({ valid: false, reason: "wrong tsa" }),
    });
    const adapterB = makeAdapter({
      tsaUrl,
      verifyResult: Promise.resolve({ valid: true }),
    });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const receipt = makeReceipt(tsaUrl);
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(true);
    // adapterB (the matching one) must have been called
    expect(adapterB.verify).toHaveBeenCalled();
  });

  it("falls back to full scan when no adapter matches receipt.tsa", async () => {
    const adapterA = makeAdapter({
      tsaUrl: "https://tsa-a.example.com",
      verifyResult: Promise.resolve({ valid: true }),
    });
    const fa = new FallbackAdapter([adapterA]);
    // receipt.tsa does not match adapterA.tsaUrl
    const receipt = makeReceipt("https://unknown-tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    // Full scan should still call adapterA and return its result
    expect(adapterA.verify).toHaveBeenCalled();
    expect(result.valid).toBe(true);
  });
});

// ─── verify() — failure cases ────────────────────────────────────────────────

describe("FallbackAdapter.verify() — all fail", () => {
  it("returns { valid: false } when all adapters throw during verify", async () => {
    const adapterA = makeAdapter({
      verifyResult: new Error("verify failed A"),
    });
    const adapterB = makeAdapter({
      verifyResult: new Error("verify failed B"),
    });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const receipt = makeReceipt("https://tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(false);
  });

  it("returns { valid: false } when all adapters return valid=false", async () => {
    const adapterA = makeAdapter({
      verifyResult: Promise.resolve({ valid: false, reason: "invalid sig A" }),
    });
    const adapterB = makeAdapter({
      verifyResult: Promise.resolve({ valid: false, reason: "invalid sig B" }),
    });
    const fa = new FallbackAdapter([adapterA, adapterB]);
    const receipt = makeReceipt("https://tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(false);
  });

  it("includes a reason string when all adapters fail to verify", async () => {
    const adapterA = makeAdapter({
      verifyResult: Promise.resolve({ valid: false, reason: "bad timestamp" }),
    });
    const fa = new FallbackAdapter([adapterA]);
    const receipt = makeReceipt("https://tsa.example.com");
    const result = await fa.verify(receipt, "hash123");
    expect(result.valid).toBe(false);
    expect(typeof result.reason).toBe("string");
  });
});
