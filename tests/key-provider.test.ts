/**
 * Tests for ports/key-provider.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyProvider, ExternalKMSKeyProvider } from "../src/ports/key-provider.js";

// ─── EnvKeyProvider ───────────────────────────────────────────────────────────

describe("EnvKeyProvider", () => {
  const TEST_KEY_ID = "TEST_HMAC_KEY_PROVIDER_TEST";
  const TEST_KEY_HEX = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 32 bytes

  beforeEach(() => {
    // Clean up env before each test
    delete process.env[TEST_KEY_ID];
    delete process.env.TRACE_DB_URL;
  });

  afterEach(() => {
    // Clean up env after each test
    delete process.env[TEST_KEY_ID];
    delete process.env.TRACE_DB_URL;
  });

  describe("getKey", () => {
    it("returns Uint8Array for a valid hex key", async () => {
      process.env[TEST_KEY_ID] = TEST_KEY_HEX;
      const provider = new EnvKeyProvider();
      const key = await provider.getKey(TEST_KEY_ID);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
      expect(key[0]).toBe(0xde);
      expect(key[1]).toBe(0xad);
    });

    it("throws when key is not in env", async () => {
      const provider = new EnvKeyProvider();
      await expect(provider.getKey(TEST_KEY_ID)).rejects.toThrow(
        `EnvKeyProvider: key "${TEST_KEY_ID}" not found`,
      );
    });

    it("throws when key is empty string", async () => {
      process.env[TEST_KEY_ID] = "";
      const provider = new EnvKeyProvider();
      await expect(provider.getKey(TEST_KEY_ID)).rejects.toThrow("not found in process.env");
    });

    it("throws when key is not valid hex", async () => {
      process.env[TEST_KEY_ID] = "notvalidhex!!";
      const provider = new EnvKeyProvider();
      await expect(provider.getKey(TEST_KEY_ID)).rejects.toThrow("valid even-length hex string");
    });

    it("throws when key has odd-length hex", async () => {
      process.env[TEST_KEY_ID] = "abc"; // odd length
      const provider = new EnvKeyProvider();
      await expect(provider.getKey(TEST_KEY_ID)).rejects.toThrow("valid even-length hex string");
    });
  });

  describe("hasColocationRisk", () => {
    it("returns true when TRACE_DB_URL is set", () => {
      process.env.TRACE_DB_URL = "postgresql://localhost:5432/trace";
      const provider = new EnvKeyProvider();
      expect(provider.hasColocationRisk()).toBe(true);
    });

    it("returns false when TRACE_DB_URL is not set", () => {
      delete process.env.TRACE_DB_URL;
      const provider = new EnvKeyProvider();
      expect(provider.hasColocationRisk()).toBe(false);
    });
  });
});

// ─── ExternalKMSKeyProvider ───────────────────────────────────────────────────

describe("ExternalKMSKeyProvider", () => {
  describe("constructor", () => {
    it("constructs successfully with a valid endpoint", () => {
      expect(
        () =>
          new ExternalKMSKeyProvider({
            endpoint: "https://vault.example.com",
          }),
      ).not.toThrow();
    });

    it("throws when endpoint is empty string", () => {
      expect(() => new ExternalKMSKeyProvider({ endpoint: "" })).toThrow(
        "options.endpoint is required",
      );
    });

    it("throws when endpoint is whitespace only", () => {
      expect(() => new ExternalKMSKeyProvider({ endpoint: "   " })).toThrow(
        "options.endpoint is required",
      );
    });

    it("accepts an optional authToken", () => {
      expect(
        () =>
          new ExternalKMSKeyProvider({
            endpoint: "https://kms.example.com",
            authToken: "s.abc123",
          }),
      ).not.toThrow();
    });
  });

  describe("hasColocationRisk", () => {
    it("always returns false", () => {
      const provider = new ExternalKMSKeyProvider({
        endpoint: "https://vault.example.com",
      });
      expect(provider.hasColocationRisk()).toBe(false);
    });
  });

  describe("getKey (stub)", () => {
    it("throws a stub-not-implemented error", async () => {
      const provider = new ExternalKMSKeyProvider({
        endpoint: "https://vault.example.com",
      });
      await expect(provider.getKey("my-key")).rejects.toThrow("stub not implemented");
    });
  });
});
