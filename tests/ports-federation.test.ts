/**
 * Unit tests for FederationPort typed error classes.
 *
 * Tests: FederationSignatureInvalidError, FederationRoutingError,
 * FederationDelegationChainError, FederationMessageExpiredError.
 */

import { describe, expect, test } from "vitest";
import {
  FederationDelegationChainError,
  FederationMessageExpiredError,
  FederationRoutingError,
  FederationSignatureInvalidError,
} from "../src/ports/federation.js";

// ─── FederationSignatureInvalidError ─────────────────────────────────────────

describe("FederationSignatureInvalidError", () => {
  test("is an instance of Error", () => {
    const err = new FederationSignatureInvalidError("msg-001", "bad sig");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is FederationSignatureInvalidError", () => {
    const err = new FederationSignatureInvalidError("msg-001", "bad sig");
    expect(err.name).toBe("FederationSignatureInvalidError");
  });

  test("messageId field is stored correctly", () => {
    const err = new FederationSignatureInvalidError("msg-abc", "fail");
    expect(err.messageId).toBe("msg-abc");
  });

  test("reason field is stored correctly", () => {
    const err = new FederationSignatureInvalidError("msg-xyz", "Ed25519 verification failed");
    expect(err.reason).toBe("Ed25519 verification failed");
  });

  test("message includes messageId", () => {
    const err = new FederationSignatureInvalidError("msg-id-42", "bad sig");
    expect(err.message).toContain("msg-id-42");
  });

  test("message includes reason", () => {
    const err = new FederationSignatureInvalidError("msg-id-42", "nonce mismatch");
    expect(err.message).toContain("nonce mismatch");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new FederationSignatureInvalidError("msg-1", "r");
    expect(err instanceof FederationSignatureInvalidError).toBe(true);
  });

  test("stack trace is defined", () => {
    const err = new FederationSignatureInvalidError("msg-2", "r");
    expect(err.stack).toBeDefined();
  });
});

// ─── FederationRoutingError ───────────────────────────────────────────────────

describe("FederationRoutingError", () => {
  test("is an instance of Error", () => {
    const err = new FederationRoutingError("tenant-1", "no route");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is FederationRoutingError", () => {
    const err = new FederationRoutingError("tenant-1", "no route");
    expect(err.name).toBe("FederationRoutingError");
  });

  test("tenantId field is stored correctly", () => {
    const err = new FederationRoutingError("tenant-xyz", "ring failure");
    expect(err.tenantId).toBe("tenant-xyz");
  });

  test("reason field is stored correctly", () => {
    const err = new FederationRoutingError("tenant-1", "consistent hash miss");
    expect(err.reason).toBe("consistent hash miss");
  });

  test("message includes tenantId", () => {
    const err = new FederationRoutingError("my-tenant", "offline");
    expect(err.message).toContain("my-tenant");
  });

  test("message includes reason", () => {
    const err = new FederationRoutingError("t", "node unavailable");
    expect(err.message).toContain("node unavailable");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new FederationRoutingError("t", "r");
    expect(err instanceof FederationRoutingError).toBe(true);
  });
});

// ─── FederationDelegationChainError ──────────────────────────────────────────

describe("FederationDelegationChainError", () => {
  test("is an instance of Error", () => {
    const err = new FederationDelegationChainError("msg-1", 2, "narrowing");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is FederationDelegationChainError", () => {
    const err = new FederationDelegationChainError("msg-1", 2, "narrowing");
    expect(err.name).toBe("FederationDelegationChainError");
  });

  test("messageId field is stored correctly", () => {
    const err = new FederationDelegationChainError("msg-delegate-99", 1, "expired");
    expect(err.messageId).toBe("msg-delegate-99");
  });

  test("chainDepth field is stored correctly", () => {
    const err = new FederationDelegationChainError("msg-1", 5, "reason");
    expect(err.chainDepth).toBe(5);
  });

  test("reason field is stored correctly", () => {
    const err = new FederationDelegationChainError("msg-1", 3, "scope escalation");
    expect(err.reason).toBe("scope escalation");
  });

  test("message includes messageId", () => {
    const err = new FederationDelegationChainError("msg-chain-abc", 2, "r");
    expect(err.message).toContain("msg-chain-abc");
  });

  test("message includes chainDepth", () => {
    const err = new FederationDelegationChainError("msg-1", 7, "r");
    expect(err.message).toContain("7");
  });

  test("message includes reason", () => {
    const err = new FederationDelegationChainError("msg-1", 1, "capability widening");
    expect(err.message).toContain("capability widening");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new FederationDelegationChainError("m", 0, "r");
    expect(err instanceof FederationDelegationChainError).toBe(true);
  });

  test("chainDepth of 0 is valid (leaf-only message)", () => {
    const err = new FederationDelegationChainError("msg-leaf", 0, "no chain");
    expect(err.chainDepth).toBe(0);
  });
});

// ─── FederationMessageExpiredError ────────────────────────────────────────────

describe("FederationMessageExpiredError", () => {
  test("is an instance of Error", () => {
    const err = new FederationMessageExpiredError("msg-1", "2024-01-01T00:00:00Z");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is FederationMessageExpiredError", () => {
    const err = new FederationMessageExpiredError("msg-1", "2024-01-01T00:00:00Z");
    expect(err.name).toBe("FederationMessageExpiredError");
  });

  test("messageId field is stored correctly", () => {
    const err = new FederationMessageExpiredError("expired-msg-42", "2024-06-01T12:00:00Z");
    expect(err.messageId).toBe("expired-msg-42");
  });

  test("notAfter field is stored correctly", () => {
    const notAfter = "2023-12-31T23:59:59Z";
    const err = new FederationMessageExpiredError("msg-1", notAfter);
    expect(err.notAfter).toBe(notAfter);
  });

  test("message includes messageId", () => {
    const err = new FederationMessageExpiredError("msg-stale-7", "2023-01-01T00:00:00Z");
    expect(err.message).toContain("msg-stale-7");
  });

  test("message includes notAfter timestamp", () => {
    const notAfter = "2023-05-20T10:00:00Z";
    const err = new FederationMessageExpiredError("msg-1", notAfter);
    expect(err.message).toContain(notAfter);
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new FederationMessageExpiredError("m", "2023-01-01T00:00:00Z");
    expect(err instanceof FederationMessageExpiredError).toBe(true);
  });

  test("different errors are not cross-instanceof", () => {
    const sig = new FederationSignatureInvalidError("m", "r");
    expect(sig instanceof FederationMessageExpiredError).toBe(false);
  });
});
