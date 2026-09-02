/**
 * Tests for sub-token OTEL instrumentation (P11).
 *
 * The instrumented wrappers must :
 *   - Preserve the pure functions' semantics (same inputs → same outputs)
 *   - Not throw under the no-op OTEL tracer (the default in test env)
 *   - Hash jtis safely (8-char prefix, no raw jti leak)
 *   - Classify verify reasons into stable label buckets
 */

import { describe, expect, it } from "vitest";
import {
  classifyReason,
  hashJti,
  mintSubToken,
  mintSubTokenInstrumented,
  recordRevocation,
  resolveAuthScope,
  resolveAuthScopeInstrumented,
  verifySubToken,
  verifySubTokenInstrumented,
} from "../../src/remote/index.js";

const PARENT = "parent-secret-otel-test";

describe("instrumentation preserves semantics", () => {
  it("mintSubTokenInstrumented returns the same shape as mintSubToken", () => {
    const a = mintSubTokenInstrumented({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const b = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    // Format check : payload.sig, both base64url.
    expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Both verify under the same parent.
    expect(verifySubToken(PARENT, a).valid).toBe(true);
    expect(verifySubToken(PARENT, b).valid).toBe(true);
  });

  it("mintSubTokenInstrumented propagates option errors", () => {
    expect(() =>
      mintSubTokenInstrumented({
        parentToken: PARENT,
        // @ts-expect-error — invalid scope on purpose
        scope: "godmode",
        ttlSec: 60,
      }),
    ).toThrow(/unknown scope/);
  });

  it("verifySubTokenInstrumented preserves valid result shape", () => {
    const token = mintSubToken({
      parentToken: PARENT,
      scope: "approve-only",
      ttlSec: 60,
    });
    const r = verifySubTokenInstrumented(PARENT, token);
    expect(r.valid).toBe(true);
    expect(r.scope).toBe("approve-only");
    expect(typeof r.jti).toBe("string");
  });

  it("verifySubTokenInstrumented preserves invalid result shapes", () => {
    const r1 = verifySubTokenInstrumented(PARENT, "garbage");
    expect(r1.valid).toBe(false);
    expect(r1.reason).toBe("malformed");

    const expired = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
      now: () => Date.now() - 7200 * 1000, // 2h ago
    });
    const r2 = verifySubTokenInstrumented(PARENT, expired);
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe("expired");
  });

  it("resolveAuthScopeInstrumented agrees with the pure variant", () => {
    const subToken = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    expect(resolveAuthScopeInstrumented(PARENT, PARENT)).toBe("full");
    expect(resolveAuthScope(PARENT, PARENT)).toBe("full");

    expect(resolveAuthScopeInstrumented(PARENT, subToken)).toBe("read-only");
    expect(resolveAuthScope(PARENT, subToken)).toBe("read-only");

    expect(resolveAuthScopeInstrumented(PARENT, "junk")).toBeUndefined();
  });

  it("resolveAuthScopeInstrumented respects the isRevoked callback", () => {
    const subToken = mintSubToken({
      parentToken: PARENT,
      scope: "full",
      ttlSec: 60,
    });
    const r1 = resolveAuthScopeInstrumented(PARENT, subToken);
    expect(r1).toBe("full");
    // Now revoke every jti — same token should resolve to undefined.
    const r2 = resolveAuthScopeInstrumented(PARENT, subToken, Date.now(), () => true);
    expect(r2).toBeUndefined();
  });

  it("recordRevocation does not throw under no-op tracer", () => {
    expect(() => recordRevocation("any-jti-123", false)).not.toThrow();
    expect(() => recordRevocation("any-jti-123", true)).not.toThrow();
  });
});

describe("hashJti — privacy-preserving log helper", () => {
  it("returns an 8-char hex prefix of sha256(jti)", () => {
    const h = hashJti("some-jti");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashJti("x")).toBe(hashJti("x"));
  });

  it("differs for different inputs (with overwhelming probability)", () => {
    expect(hashJti("a")).not.toBe(hashJti("b"));
  });

  it("never returns the raw jti", () => {
    const raw = "this-is-a-very-distinctive-jti-12345";
    expect(hashJti(raw)).not.toContain("this-is-a-very-distinctive-jti");
    expect(hashJti(raw).length).toBe(8);
  });
});

describe("classifyReason — verify outcome buckets", () => {
  it("classifies malformed-shape reasons", () => {
    expect(classifyReason("malformed")).toBe("malformed");
    expect(classifyReason("payload not JSON")).toBe("bad_payload");
  });

  it("classifies expiry", () => {
    expect(classifyReason("expired")).toBe("expired");
  });

  it("classifies signature failures", () => {
    expect(classifyReason("signature mismatch")).toBe("sig_mismatch");
    expect(classifyReason("signature decode failed")).toBe("sig_mismatch");
  });

  it("classifies scope problems", () => {
    expect(classifyReason("scope missing or unknown")).toBe("unknown_scope");
  });

  it("classifies version problems", () => {
    expect(classifyReason("unsupported version 2")).toBe("wrong_version");
  });

  it("falls back to unknown_error for surprising reasons", () => {
    expect(classifyReason("something nobody catalogued")).toBe("unknown_error");
  });
});
