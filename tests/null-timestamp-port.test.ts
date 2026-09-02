/**
 * Tests for src/ports/timestamp.ts — NullTimestampPort
 *
 * Coverage:
 *   NullTimestampPort.request — always throws with actionable message
 *   NullTimestampPort.verify — always returns { valid: false, reason }
 *
 * Ref: test coverage for src/ports/timestamp.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { NullTimestampPort } from "../src/ports/timestamp.js";

const FAKE_RECEIPT = {
  tsa_cert_sha256: "abc",
  ts_token_b64: "base64token",
  policy_oid: "1.2.3",
  hash_alg: "sha256",
  imprint_hex: "deadbeef",
  gen_time_utc: "20260101000000Z",
  serial_hex: "01",
};

describe("NullTimestampPort", () => {
  it("request() throws with 'NullTimestampPort' in the message", async () => {
    const port = new NullTimestampPort();
    await expect(port.request("abc123")).rejects.toThrow("NullTimestampPort");
  });

  it("request() message mentions configuring a real port", async () => {
    const port = new NullTimestampPort();
    try {
      await port.request("hash");
    } catch (err) {
      expect((err as Error).message).toContain("FreeTSAAdapter");
    }
  });

  it("verify() returns { valid: false } for any input", async () => {
    const port = new NullTimestampPort();
    const result = await port.verify(FAKE_RECEIPT as never, "somehash");
    expect(result.valid).toBe(false);
  });

  it("verify() includes a reason string", async () => {
    const port = new NullTimestampPort();
    const result = await port.verify(FAKE_RECEIPT as never, "hash");
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it("request() throws an Error instance (not a string or custom class)", async () => {
    const port = new NullTimestampPort();
    await expect(port.request("deadbeef")).rejects.toBeInstanceOf(Error);
  });

  it("verify() returns { valid: false } regardless of rootHash value", async () => {
    const port = new NullTimestampPort();
    for (const hash of ["", "0000", "a".repeat(64)]) {
      const result = await port.verify(FAKE_RECEIPT as never, hash);
      expect(result.valid).toBe(false);
    }
  });

  it("each NullTimestampPort instance behaves identically (no shared state)", async () => {
    const portA = new NullTimestampPort();
    const portB = new NullTimestampPort();
    const [a, b] = await Promise.all([
      portA.verify(FAKE_RECEIPT as never, "hash"),
      portB.verify(FAKE_RECEIPT as never, "hash"),
    ]);
    expect(a.valid).toBe(false);
    expect(b.valid).toBe(false);
    expect(a.reason).toBe(b.reason);
  });
});
