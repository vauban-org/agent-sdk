/**
 * Tests for HMAC-attenuated sub-tokens (T6f capability-scoped handoff).
 * Covers mint, verify happy-path, every failure mode the verifier should
 * catch, scope hierarchy, and the resolveAuthScope dispatcher.
 */

import { describe, expect, it } from "vitest";

import {
  type SubTokenScope,
  mintSubToken,
  resolveAuthScope,
  scopeCovers,
  verifySubToken,
} from "../src/remote/sub-token.js";

const PARENT = "parent-token-hex-deadbeef";

describe("scopeCovers", () => {
  it.each<[SubTokenScope, SubTokenScope, boolean]>([
    ["read-only", "read-only", true],
    ["read-only", "approve-only", false],
    ["read-only", "full", false],
    ["approve-only", "read-only", true],
    ["approve-only", "approve-only", true],
    ["approve-only", "full", false],
    ["full", "read-only", true],
    ["full", "approve-only", true],
    ["full", "full", true],
  ])("granted=%s covers required=%s -> %s", (g, r, expected) => {
    expect(scopeCovers(g, r)).toBe(expected);
  });
});

describe("mintSubToken", () => {
  it("returns a base64url <payload>.<sig> string", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(tok.split(".")).toHaveLength(2);
  });

  it("rejects empty parent token", () => {
    expect(() => mintSubToken({ parentToken: "", scope: "read-only", ttlSec: 60 })).toThrowError(
      /parentToken/,
    );
  });

  it("rejects non-positive ttl", () => {
    expect(() => mintSubToken({ parentToken: PARENT, scope: "read-only", ttlSec: 0 })).toThrowError(
      /ttlSec/,
    );
    expect(() =>
      mintSubToken({ parentToken: PARENT, scope: "read-only", ttlSec: -5 }),
    ).toThrowError(/ttlSec/);
  });

  it("rejects non-integer ttl", () => {
    expect(() =>
      mintSubToken({ parentToken: PARENT, scope: "read-only", ttlSec: 1.5 }),
    ).toThrowError(/ttlSec/);
  });

  it("rejects unknown scope", () => {
    expect(() =>
      mintSubToken({
        parentToken: PARENT,
        scope: "admin" as SubTokenScope,
        ttlSec: 60,
      }),
    ).toThrowError(/unknown scope/);
  });

  it("each mint emits a distinct jti (uniqueness via random)", () => {
    const a = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const b = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    expect(a).not.toBe(b);
  });
});

describe("verifySubToken", () => {
  it("accepts a freshly minted token under the right parent", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "approve-only",
      ttlSec: 60,
    });
    const v = verifySubToken(PARENT, tok);
    expect(v.valid).toBe(true);
    expect(v.scope).toBe("approve-only");
    expect(v.jti).toMatch(/^[a-f0-9]{12}$/);
  });

  it("rejects when verified against a different parent", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const v = verifySubToken("other-token", tok);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });

  it("rejects an expired token (now > exp)", () => {
    const t0 = 1_700_000_000_000;
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
      now: () => t0,
    });
    const past = verifySubToken(PARENT, tok, t0 + 1_000); // still inside TTL
    expect(past.valid).toBe(true);

    const expired = verifySubToken(PARENT, tok, t0 + 120_000); // beyond TTL
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe("expired");
  });

  it("rejects payload tampering (scope upgrade attempt)", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const [payloadB64, sigB64] = tok.split(".");
    const claims = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf-8"));
    claims.scope = "full"; // attacker tries to elevate
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const forged = `${forgedPayload}.${sigB64 ?? ""}`;
    const v = verifySubToken(PARENT, forged);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });

  it("rejects signature tampering", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const [payloadB64] = tok.split(".");
    const forged = `${payloadB64}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifySubToken(PARENT, forged).valid).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(verifySubToken(PARENT, "").valid).toBe(false);
    expect(verifySubToken(PARENT, "not.a.token").valid).toBe(false);
    expect(verifySubToken(PARENT, "missing-dot-here").valid).toBe(false);
  });

  it("rejects payloads with unsupported version", () => {
    const claims = {
      v: 99,
      scope: "read-only",
      exp: 9_999_999_999,
      jti: "abc",
    };
    const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = require("node:crypto")
      .createHmac("sha256", PARENT)
      .update(payloadB64)
      .digest()
      .toString("base64url");
    const v = verifySubToken(PARENT, `${payloadB64}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/unsupported version/);
  });

  it("rejects payloads with unknown scope", () => {
    const claims = { v: 1, scope: "godmode", exp: 9_999_999_999, jti: "abc" };
    const payloadB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = require("node:crypto")
      .createHmac("sha256", PARENT)
      .update(payloadB64)
      .digest()
      .toString("base64url");
    const v = verifySubToken(PARENT, `${payloadB64}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/scope/);
  });
});

describe("resolveAuthScope", () => {
  it("returns 'full' when the presented token equals the parent token", () => {
    expect(resolveAuthScope(PARENT, PARENT)).toBe("full");
  });

  it("returns the sub-token's scope when valid", () => {
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    expect(resolveAuthScope(PARENT, tok)).toBe("read-only");
  });

  it("returns undefined for an empty presented token", () => {
    expect(resolveAuthScope(PARENT, "")).toBeUndefined();
  });

  it("returns undefined for an empty parent token (no auth surface)", () => {
    expect(resolveAuthScope("", "anything")).toBeUndefined();
  });

  it("returns undefined for an expired sub-token", () => {
    const t0 = 1_700_000_000_000;
    const tok = mintSubToken({
      parentToken: PARENT,
      scope: "full",
      ttlSec: 60,
      now: () => t0,
    });
    expect(resolveAuthScope(PARENT, tok, t0 + 120_000)).toBeUndefined();
  });

  it("returns undefined for a forged sub-token under a different parent", () => {
    const tok = mintSubToken({
      parentToken: "other",
      scope: "full",
      ttlSec: 60,
    });
    expect(resolveAuthScope(PARENT, tok)).toBeUndefined();
  });

  describe("revocation", () => {
    it("returns undefined when isRevoked(jti) reports true", () => {
      const tok = mintSubToken({
        parentToken: PARENT,
        scope: "read-only",
        ttlSec: 60,
      });
      const v = verifySubToken(PARENT, tok);
      const revokedJti = v.jti ?? "";
      expect(revokedJti).not.toBe("");

      const allow = resolveAuthScope(PARENT, tok, Date.now(), () => false);
      expect(allow).toBe("read-only");

      const deny = resolveAuthScope(PARENT, tok, Date.now(), (jti) => jti === revokedJti);
      expect(deny).toBeUndefined();
    });

    it("does not consult isRevoked for the parent token (no jti)", () => {
      let called = false;
      const scope = resolveAuthScope(PARENT, PARENT, Date.now(), () => {
        called = true;
        return true;
      });
      expect(scope).toBe("full");
      expect(called).toBe(false);
    });

    it("does not consult isRevoked when the sub-token is invalid", () => {
      let called = false;
      const scope = resolveAuthScope(PARENT, "garbage.string", Date.now(), () => {
        called = true;
        return true;
      });
      expect(scope).toBeUndefined();
      expect(called).toBe(false);
    });
  });
});
