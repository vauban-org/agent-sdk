/**
 * Tests for proof/sha256 — Web Crypto wrappers.
 *
 * Vectors:
 *   SHA-256("") → e3b0c4... (FIPS 180-4 test vector)
 *   SHA-256("abc") → ba7816bf... (FIPS 180-4 test vector)
 *   HMAC-SHA-256 vector from RFC 4231 Test Case 2.
 */

import { describe, expect, it } from "vitest";
import { hmacSha256, sha256 } from "../src/proof/sha256.js";

describe("proof/sha256", () => {
  describe("sha256", () => {
    it('sha256("") matches FIPS 180-4 empty-string vector', async () => {
      const result = await sha256("");
      expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it('sha256("abc") matches FIPS 180-4 vector', async () => {
      const result = await sha256("abc");
      expect(result).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("sha256(Uint8Array) matches sha256(equivalent string)", async () => {
      const bytes = new TextEncoder().encode("abc");
      const fromBytes = await sha256(bytes);
      const fromString = await sha256("abc");
      expect(fromBytes).toBe(fromString);
    });

    it("returns lowercase hex of exactly 64 chars", async () => {
      const result = await sha256("test");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("different inputs produce different digests", async () => {
      const a = await sha256("hello");
      const b = await sha256("world");
      expect(a).not.toBe(b);
    });
  });

  describe("hmacSha256", () => {
    /**
     * RFC 4231 Test Case 2:
     *   Key = 4a656665 (ASCII "Jefe")
     *   Data = "what do ya want for nothing?"
     *   HMAC = 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964a75b88
     */
    it("matches RFC 4231 Test Case 2", async () => {
      // Key = ASCII "Jefe"
      const key = new TextEncoder().encode("Jefe");
      const result = await hmacSha256(key, "what do ya want for nothing?");
      expect(result).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    });

    it("accepts Uint8Array input", async () => {
      const key = new TextEncoder().encode("Jefe");
      const dataBytes = new TextEncoder().encode("what do ya want for nothing?");
      const fromBytes = await hmacSha256(key, dataBytes);
      const fromString = await hmacSha256(key, "what do ya want for nothing?");
      expect(fromBytes).toBe(fromString);
    });

    it("different keys produce different MACs", async () => {
      const key1 = new TextEncoder().encode("key1");
      const key2 = new TextEncoder().encode("key2");
      const mac1 = await hmacSha256(key1, "message");
      const mac2 = await hmacSha256(key2, "message");
      expect(mac1).not.toBe(mac2);
    });

    it("different messages produce different MACs with same key", async () => {
      const key = new TextEncoder().encode("shared-key");
      const mac1 = await hmacSha256(key, "message-a");
      const mac2 = await hmacSha256(key, "message-b");
      expect(mac1).not.toBe(mac2);
    });

    it("returns lowercase hex of exactly 64 chars", async () => {
      const key = new TextEncoder().encode("key");
      const result = await hmacSha256(key, "data");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic — same key and input always produce the same MAC", async () => {
      const key = new TextEncoder().encode("stable-key");
      const mac1 = await hmacSha256(key, "stable-input");
      const mac2 = await hmacSha256(key, "stable-input");
      expect(mac1).toBe(mac2);
    });

    it("32-byte key (minimum recommended size) is accepted", async () => {
      const key = new Uint8Array(32).fill(0xcc);
      const result = await hmacSha256(key, "payload");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("1-byte key (minimum technically valid) is accepted", async () => {
      const key = new Uint8Array([0x01]);
      await expect(hmacSha256(key, "payload")).resolves.toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

// ─── Cross-function consistency ────────────────────────────────────────────────

describe("sha256 + hmacSha256 cross-function", () => {
  it('sha256("hello") matches well-known vector', async () => {
    const result = await sha256("hello");
    expect(result).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("sha256 and hmacSha256 produce distinct outputs for the same string", async () => {
    const key = new TextEncoder().encode("hello");
    const plain = await sha256("hello");
    const mac = await hmacSha256(key, "hello");
    expect(plain).not.toBe(mac);
  });

  it("Uint8Array copy of key does not affect MAC (copy semantics)", async () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const clone = new Uint8Array(original);
    const mac1 = await hmacSha256(original, "test");
    const mac2 = await hmacSha256(clone, "test");
    expect(mac1).toBe(mac2);
  });

  it("sha256 of a long string returns a 64-char digest", async () => {
    const longInput = "a".repeat(10_000);
    const result = await sha256(longInput);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hmacSha256 of a long message returns a 64-char digest", async () => {
    const key = new Uint8Array(32).fill(0x42);
    const longInput = "b".repeat(10_000);
    const result = await hmacSha256(key, longInput);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
