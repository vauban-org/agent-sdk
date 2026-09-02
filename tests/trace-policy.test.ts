/**
 * Tests for trace/policy.ts and trace/strict-pii-detector.ts.
 */

import { describe, expect, it } from "vitest";
import { type PayloadPolicy, defaultPolicy, payloadHash } from "../src/trace/policy.js";
import { STRICT_PII_DETECTOR } from "../src/trace/strict-pii-detector.js";

// ─── defaultPolicy ────────────────────────────────────────────────────────────

describe("defaultPolicy", () => {
  describe("prod — fail-closed", () => {
    it("throws PRODUCTION_PII_FIELDS_REQUIRED when called without piiFields", () => {
      expect(() => defaultPolicy("prod")).toThrowError("PRODUCTION_PII_FIELDS_REQUIRED");
    });

    it("throws PRODUCTION_PII_FIELDS_REQUIRED when piiFields is empty array", () => {
      expect(() => defaultPolicy("prod", [])).toThrowError("PRODUCTION_PII_FIELDS_REQUIRED");
    });

    it("returns redact policy with piiFields and NO piiDetector (R8-I3)", () => {
      const policy = defaultPolicy("prod", ["email"]);
      expect(policy.kind).toBe("redact");
      if (policy.kind === "redact") {
        expect(policy.piiFields).toEqual(["email"]);
        // piiDetector must be undefined by default — STRICT_PII_DETECTOR is opt-in only
        expect(policy.piiDetector).toBeUndefined();
      }
    });

    it("accepts multiple piiFields", () => {
      const policy = defaultPolicy("prod", ["email", "iban", "fullName"]);
      expect(policy.kind).toBe("redact");
      if (policy.kind === "redact") {
        expect(policy.piiFields).toContain("email");
        expect(policy.piiFields).toContain("iban");
      }
    });
  });

  describe("dev — open", () => {
    it("returns include policy", () => {
      const policy = defaultPolicy("dev");
      expect(policy).toEqual({ kind: "include" });
    });

    it("returns include policy even when piiFields is provided", () => {
      // piiFields is ignored in dev — include is always the result
      const policy = defaultPolicy("dev", ["email"]);
      expect(policy.kind).toBe("include");
    });
  });
});

// ─── payloadHash — basic contract ─────────────────────────────────────────────

describe("payloadHash", () => {
  describe("include policy", () => {
    it("returns hash, policy=include, storedValue=input", async () => {
      const input = { name: "Alice", amount: 42 };
      const policy: PayloadPolicy = { kind: "include" };
      const result = await payloadHash(input, policy);

      expect(result.policy).toBe("include");
      expect(result.storedValue).toEqual(input);
      expect(typeof result.hash).toBe("string");
      expect(result.hash).toHaveLength(64); // SHA-256 hex = 64 chars
    });

    it("produces deterministic hash for same input", async () => {
      const input = { b: 2, a: 1 };
      const policy: PayloadPolicy = { kind: "include" };
      const r1 = await payloadHash(input, policy);
      const r2 = await payloadHash(input, policy);
      expect(r1.hash).toBe(r2.hash);
    });

    it("produces same hash regardless of key order", async () => {
      const p: PayloadPolicy = { kind: "include" };
      const r1 = await payloadHash({ a: 1, b: 2 }, p);
      const r2 = await payloadHash({ b: 2, a: 1 }, p);
      expect(r1.hash).toBe(r2.hash);
    });
  });

  describe("redact policy", () => {
    it("redacts piiFields from storedValue", async () => {
      const input = { email: "alice@example.com", amount: 100 };
      const policy: PayloadPolicy = { kind: "redact", piiFields: ["email"] };
      const result = await payloadHash(input, policy);

      expect(result.policy).toBe("redact");
      const stored = result.storedValue as Record<string, unknown>;
      expect(stored.email).toBe("[REDACTED]");
      expect(stored.amount).toBe(100);
    });

    it("hash is SHA-256 of canonical(redacted) not canonical(original)", async () => {
      const input = { email: "alice@example.com", amount: 100 };
      const policy: PayloadPolicy = { kind: "redact", piiFields: ["email"] };
      const result = await payloadHash(input, policy);

      // Recompute hash of redacted value manually
      const { canonicalize } = await import("../src/trace/canonical.js");
      const redacted = { amount: 100, email: "[REDACTED]" };
      const encoder = new TextEncoder();
      const buf = await globalThis.crypto.subtle.digest(
        "SHA-256",
        encoder.encode(canonicalize(redacted)),
      );
      const expectedHash = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(result.hash).toBe(expectedHash);
    });
  });

  describe("hash-only policy", () => {
    it("returns hash, policy=hash-only, no storedValue", async () => {
      const input = { secret: "top-secret" };
      const policy: PayloadPolicy = { kind: "hash-only" };
      const result = await payloadHash(input, policy);

      expect(result.policy).toBe("hash-only");
      expect(result.storedValue).toBeUndefined();
      expect(result.hash).toHaveLength(64);
    });
  });
});

// ─── STRICT_PII_DETECTOR ──────────────────────────────────────────────────────

describe("STRICT_PII_DETECTOR", () => {
  describe("emails (RFC 5321 compliant)", () => {
    it("detects a valid email", () => {
      expect(STRICT_PII_DETECTOR("user@example.com")).toBe(true);
    });

    it("detects email with subdomain", () => {
      expect(STRICT_PII_DETECTOR("user@mail.example.co.uk")).toBe(true);
    });

    it("detects email with + in local part", () => {
      expect(STRICT_PII_DETECTOR("user+tag@example.com")).toBe(true);
    });

    it("does NOT flag plain words", () => {
      expect(STRICT_PII_DETECTOR("hello world")).toBe(false);
    });

    it("does NOT flag a string with only @", () => {
      expect(STRICT_PII_DETECTOR("noatsign")).toBe(false);
    });

    it("does NOT flag invalid TLD (single char)", () => {
      expect(STRICT_PII_DETECTOR("user@example.c")).toBe(false);
    });

    it("does NOT flag missing domain", () => {
      expect(STRICT_PII_DETECTOR("user@")).toBe(false);
    });
  });

  describe("IBANs (ISO 13616 with mod-97 checksum)", () => {
    it("detects a valid UK IBAN", () => {
      // GB82WEST12345698765432 — canonical example from ISO 13616
      expect(STRICT_PII_DETECTOR("GB82WEST12345698765432")).toBe(true);
    });

    it("detects a valid German IBAN", () => {
      // DE89370400440532013000
      expect(STRICT_PII_DETECTOR("DE89370400440532013000")).toBe(true);
    });

    it("detects a valid French IBAN", () => {
      // FR7630006000011234567890189
      expect(STRICT_PII_DETECTOR("FR7630006000011234567890189")).toBe(true);
    });

    it("does NOT flag a 16-digit amount-like number", () => {
      // High risk of FP: 16-digit strings that look like account numbers
      expect(STRICT_PII_DETECTOR("1234567890123456")).toBe(false);
    });

    it("does NOT flag an IBAN with invalid checksum", () => {
      // GB82WEST12345698765433 — last digit changed, breaks mod-97
      expect(STRICT_PII_DETECTOR("GB82WEST12345698765433")).toBe(false);
    });

    it("does NOT flag an IBAN with unknown country code", () => {
      // ZZ (not a valid IBAN country)
      expect(STRICT_PII_DETECTOR("ZZ82WEST12345698765432")).toBe(false);
    });

    it("does NOT flag strings shorter than 15 characters", () => {
      expect(STRICT_PII_DETECTOR("GB82WEST1234")).toBe(false);
    });
  });

  describe("non-string values", () => {
    it("returns false for numbers", () => {
      expect(STRICT_PII_DETECTOR(42)).toBe(false);
    });

    it("returns false for null", () => {
      expect(STRICT_PII_DETECTOR(null)).toBe(false);
    });

    it("returns false for objects", () => {
      expect(STRICT_PII_DETECTOR({ email: "user@example.com" })).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(STRICT_PII_DETECTOR(undefined)).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(STRICT_PII_DETECTOR(["user@example.com"])).toBe(false);
    });
  });

  describe("STRICT_PII_DETECTOR is opt-in (R8-I3)", () => {
    it("defaultPolicy('prod', ['email']) does NOT set piiDetector", () => {
      const policy = defaultPolicy("prod", ["email"]);
      expect(policy.kind).toBe("redact");
      if (policy.kind === "redact") {
        expect(policy.piiDetector).toBeUndefined();
      }
    });

    it("can be activated explicitly in a custom policy", () => {
      const policy: PayloadPolicy = {
        kind: "redact",
        piiFields: [],
        piiDetector: STRICT_PII_DETECTOR,
      };
      expect(policy.kind).toBe("redact");
      if (policy.kind === "redact") {
        expect(policy.piiDetector).toBe(STRICT_PII_DETECTOR);
      }
    });
  });
});
