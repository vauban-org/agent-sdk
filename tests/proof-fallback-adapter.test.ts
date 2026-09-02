/**
 * Tests for proof/fallback-adapter — FallbackAdapter + AllAdaptersFailedError.
 */

import { describe, expect, it, vi } from "vitest";
import type { TimestampPort } from "../src/ports/timestamp.js";
import { AllAdaptersFailedError, FallbackAdapter } from "../src/proof/fallback-adapter.js";
import type { SignedReceipt } from "../src/trace/schema.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeReceipt(tsa: string): SignedReceipt {
  return {
    tsa,
    timestamp: new Date().toISOString(),
    signature: "sig-base64",
    algorithm: "sha-256",
    hashedMessage: "a".repeat(64),
  };
}

function successAdapter(receipt: SignedReceipt): TimestampPort {
  return {
    request: vi.fn().mockResolvedValue(receipt),
    verify: vi.fn().mockResolvedValue({ valid: true }),
  };
}

function failAdapter(msg = "TSA unavailable"): TimestampPort {
  return {
    request: vi.fn().mockRejectedValue(new Error(msg)),
    verify: vi.fn().mockResolvedValue({ valid: false, reason: msg }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FallbackAdapter", () => {
  // ── Construction ───────────────────────────────────────────────────────────

  describe("construction", () => {
    it("throws when adapters array is empty", () => {
      expect(() => new FallbackAdapter([])).toThrow("at least one adapter");
    });

    it("constructs successfully with one adapter", () => {
      const adapter = successAdapter(makeReceipt("https://freetsa.org"));
      expect(() => new FallbackAdapter([adapter])).not.toThrow();
    });
  });

  // ── request() ──────────────────────────────────────────────────────────────

  describe("request()", () => {
    it("single adapter success → returns immediately without trying others", async () => {
      const receipt = makeReceipt("https://freetsa.org");
      const a = successAdapter(receipt);
      const fallback = new FallbackAdapter([a]);

      const result = await fallback.request("a".repeat(64));
      expect(result).toEqual(receipt);
      expect(a.request).toHaveBeenCalledOnce();
    });

    it("first adapter fails, second succeeds → returns second receipt", async () => {
      const receipt = makeReceipt("https://backup-tsa.example");
      const a1 = failAdapter("a1 down");
      const a2 = successAdapter(receipt);
      const fallback = new FallbackAdapter([a1, a2]);

      const result = await fallback.request("b".repeat(64));
      expect(result).toEqual(receipt);
      expect(a1.request).toHaveBeenCalledOnce();
      expect(a2.request).toHaveBeenCalledOnce();
    });

    it("all adapters fail → throws AllAdaptersFailedError", async () => {
      const a1 = failAdapter("a1 failed");
      const a2 = failAdapter("a2 failed");
      const fallback = new FallbackAdapter([a1, a2]);

      await expect(fallback.request("c".repeat(64))).rejects.toThrow(AllAdaptersFailedError);
    });

    it("AllAdaptersFailedError aggregates individual errors", async () => {
      const a1 = failAdapter("err-one");
      const a2 = failAdapter("err-two");
      const fallback = new FallbackAdapter([a1, a2]);

      let thrown: AllAdaptersFailedError | undefined;
      try {
        await fallback.request("d".repeat(64));
      } catch (e) {
        thrown = e as AllAdaptersFailedError;
      }

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(AllAdaptersFailedError);
      expect(thrown?.errors).toHaveLength(2);
      expect((thrown?.errors[0] as Error).message).toBe("err-one");
      expect((thrown?.errors[1] as Error).message).toBe("err-two");
    });

    it("first adapter succeeds → second adapter is never called", async () => {
      const receipt = makeReceipt("https://primary-tsa.example");
      const a1 = successAdapter(receipt);
      const a2 = failAdapter("should not be called");
      const fallback = new FallbackAdapter([a1, a2]);

      await fallback.request("e".repeat(64));
      expect(a2.request).not.toHaveBeenCalled();
    });
  });

  // ── verify() ──────────────────────────────────────────────────────────────

  describe("verify()", () => {
    it("first adapter returns valid → returns valid immediately", async () => {
      const receipt = makeReceipt("https://tsa-a.example");
      const a1: TimestampPort = {
        request: vi.fn().mockResolvedValue(receipt),
        verify: vi.fn().mockResolvedValue({ valid: true }),
      };
      const a2 = failAdapter();
      const fallback = new FallbackAdapter([a1, a2]);

      const result = await fallback.verify(receipt, "a".repeat(64));
      expect(result.valid).toBe(true);
    });

    it("first adapter invalid, second valid → returns second result", async () => {
      const receipt = makeReceipt("https://tsa-b.example");
      const a1: TimestampPort = {
        request: vi.fn(),
        verify: vi.fn().mockResolvedValue({ valid: false, reason: "not my receipt" }),
      };
      const a2: TimestampPort = {
        request: vi.fn(),
        verify: vi.fn().mockResolvedValue({ valid: true }),
      };
      const fallback = new FallbackAdapter([a1, a2]);

      const result = await fallback.verify(receipt, "b".repeat(64));
      expect(result.valid).toBe(true);
    });

    it("all adapters return invalid → returns { valid: false }", async () => {
      const receipt = makeReceipt("https://unknown-tsa.example");
      const a1: TimestampPort = {
        request: vi.fn(),
        verify: vi.fn().mockResolvedValue({ valid: false, reason: "sig mismatch" }),
      };
      const a2: TimestampPort = {
        request: vi.fn(),
        verify: vi.fn().mockResolvedValue({ valid: false, reason: "cert expired" }),
      };
      const fallback = new FallbackAdapter([a1, a2]);

      const result = await fallback.verify(receipt, "c".repeat(64));
      expect(result.valid).toBe(false);
    });
  });
});
