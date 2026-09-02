/**
 * tests/trace-strict-pii-detector.test.ts
 *
 * Unit tests for STRICT_PII_DETECTOR (PIIDetector function).
 * Covers: email detection, IBAN detection, edge cases, and interface contract.
 */

import { describe, expect, it } from "vitest";
import { STRICT_PII_DETECTOR } from "../src/trace/strict-pii-detector.js";

// ─── Interface contract ───────────────────────────────────────────────────────

describe("STRICT_PII_DETECTOR — interface contract", () => {
  it("is a callable function", () => {
    expect(typeof STRICT_PII_DETECTOR).toBe("function");
  });

  it("returns a boolean, not undefined or null", () => {
    const result = STRICT_PII_DETECTOR("test@example.com");
    expect(typeof result).toBe("boolean");
  });

  it("returns false for non-string input (number)", () => {
    expect(STRICT_PII_DETECTOR(12345)).toBe(false);
  });

  it("returns false for non-string input (object)", () => {
    expect(STRICT_PII_DETECTOR({ email: "test@example.com" })).toBe(false);
  });

  it("returns false for non-string input (null)", () => {
    expect(STRICT_PII_DETECTOR(null)).toBe(false);
  });

  it("returns false for non-string input (undefined)", () => {
    expect(STRICT_PII_DETECTOR(undefined)).toBe(false);
  });

  it("returns false for non-string input (array)", () => {
    expect(STRICT_PII_DETECTOR(["test@example.com"])).toBe(false);
  });

  it("returns false for non-string input (boolean)", () => {
    expect(STRICT_PII_DETECTOR(true)).toBe(false);
  });
});

// ─── Email detection — positive cases ────────────────────────────────────────

describe("STRICT_PII_DETECTOR — email positive cases", () => {
  it("detects simple email: test@example.com", () => {
    expect(STRICT_PII_DETECTOR("test@example.com")).toBe(true);
  });

  it("detects email with plus tag: user.name+tag@domain.org", () => {
    expect(STRICT_PII_DETECTOR("user.name+tag@domain.org")).toBe(true);
  });

  it("detects email with subdomain: user@subdomain.example.co.uk", () => {
    expect(STRICT_PII_DETECTOR("user@subdomain.example.co.uk")).toBe(true);
  });

  it("detects short email: a@b.io", () => {
    expect(STRICT_PII_DETECTOR("a@b.io")).toBe(true);
  });

  it("detects email with special chars in local part: user!#$@example.com", () => {
    expect(STRICT_PII_DETECTOR("user!#$@example.com")).toBe(true);
  });

  it("detects email with leading whitespace (trimmed): '  test@example.com  '", () => {
    expect(STRICT_PII_DETECTOR("  test@example.com  ")).toBe(true);
  });
});

// ─── Email detection — negative cases ────────────────────────────────────────

describe("STRICT_PII_DETECTOR — email negative cases", () => {
  it("rejects string without @ character", () => {
    expect(STRICT_PII_DETECTOR("not-an-email")).toBe(false);
  });

  it("rejects string with no local part: @example.com", () => {
    expect(STRICT_PII_DETECTOR("@example.com")).toBe(false);
  });

  it("rejects string with no domain: user@", () => {
    expect(STRICT_PII_DETECTOR("user@")).toBe(false);
  });

  it("rejects domain with leading dot: user@.com", () => {
    expect(STRICT_PII_DETECTOR("user@.com")).toBe(false);
  });

  it("rejects TLD shorter than 2 chars: user@domain.c", () => {
    expect(STRICT_PII_DETECTOR("user@domain.c")).toBe(false);
  });

  it("rejects numeric TLD: user@domain.123", () => {
    expect(STRICT_PII_DETECTOR("user@domain.123")).toBe(false);
  });

  it("rejects plain text: hello world", () => {
    expect(STRICT_PII_DETECTOR("hello world")).toBe(false);
  });

  it("rejects plain number: 12345", () => {
    expect(STRICT_PII_DETECTOR("12345")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(STRICT_PII_DETECTOR("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(STRICT_PII_DETECTOR("   ")).toBe(false);
  });
});

// ─── IBAN detection — positive cases ─────────────────────────────────────────

describe("STRICT_PII_DETECTOR — IBAN positive cases", () => {
  it("detects valid UK IBAN: GB82WEST12345698765432", () => {
    expect(STRICT_PII_DETECTOR("GB82WEST12345698765432")).toBe(true);
  });

  it("detects valid German IBAN: DE89370400440532013000", () => {
    expect(STRICT_PII_DETECTOR("DE89370400440532013000")).toBe(true);
  });

  it("detects valid French IBAN: FR7630006000011234567890189", () => {
    expect(STRICT_PII_DETECTOR("FR7630006000011234567890189")).toBe(true);
  });

  it("detects valid Belgian IBAN: BE68539007547034", () => {
    expect(STRICT_PII_DETECTOR("BE68539007547034")).toBe(true);
  });

  it("detects IBAN with surrounding whitespace (trimmed)", () => {
    expect(STRICT_PII_DETECTOR("  GB82WEST12345698765432  ")).toBe(true);
  });
});

// ─── IBAN detection — negative cases ─────────────────────────────────────────

describe("STRICT_PII_DETECTOR — IBAN negative cases", () => {
  it("rejects string 'INVALID123456' (no valid country code)", () => {
    expect(STRICT_PII_DETECTOR("INVALID123456")).toBe(false);
  });

  it("rejects IBAN with invalid country code: XX89370400440532013000", () => {
    expect(STRICT_PII_DETECTOR("XX89370400440532013000")).toBe(false);
  });

  it("rejects IBAN with wrong checksum: DE00000000000000000000", () => {
    expect(STRICT_PII_DETECTOR("DE00000000000000000000")).toBe(false);
  });

  it("rejects all-digit string with no country code: 12345678901234567890", () => {
    expect(STRICT_PII_DETECTOR("12345678901234567890")).toBe(false);
  });

  it("rejects string that is too short to be an IBAN (< 15 chars): GB82WEST123", () => {
    expect(STRICT_PII_DETECTOR("GB82WEST123")).toBe(false);
  });

  it("rejects string that looks like IBAN but has wrong checksum: GB00WEST12345698765432", () => {
    expect(STRICT_PII_DETECTOR("GB00WEST12345698765432")).toBe(false);
  });
});
