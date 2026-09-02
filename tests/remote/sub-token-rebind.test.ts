/**
 * Unit tests for `rebindSubToken` (P1b-2 device-binding handshake).
 *
 * The integration suite in `bind-device.test.ts` exercises the HTTP endpoint
 * end-to-end. This file targets the pure function in isolation : every error
 * code path, jkt determinism, TTL boundary conditions, and inherited-field
 * invariants. No HTTP server, no PersistencePort.
 *
 * @since 2.26.0
 */

import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type EcP256Jwk,
  type SubTokenClaims,
  computeJwkThumbprint,
  mintSubToken,
  rebindSubToken,
  verifySubToken,
} from "../../src/remote/index.js";

const subtle = (globalThis.crypto ?? webcrypto).subtle;
const PARENT = "rebind-unit-parent-secret";

async function freshJwk(): Promise<EcP256Jwk> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await subtle.exportKey("jwk", kp.publicKey)) as EcP256Jwk;
  if ((jwk as { d?: string }).d !== undefined) {
    delete (jwk as { d?: string }).d;
  }
  return jwk;
}

function decodeClaims(token: string): SubTokenClaims {
  const payloadB64 = token.split(".", 2)[0] ?? "";
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as SubTokenClaims;
}

describe("rebindSubToken — happy path", () => {
  it("upgrades a bearer sub-token to device-bound — new token carries cnf.jkt matching the JWK thumbprint", async () => {
    const jwk = await freshJwk();
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 3600,
    });
    const result = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old,
      jwk,
    });
    expect(result.subToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const v = verifySubToken(PARENT, result.subToken);
    expect(v.valid).toBe(true);
    expect(v.cnf?.jkt).toBe(computeJwkThumbprint(jwk));
  });

  it("inherits the scope from the old sub-token", async () => {
    const jwk = await freshJwk();
    for (const scope of ["read-only", "approve-only", "full"] as const) {
      const old = mintSubToken({
        parentToken: PARENT,
        scope,
        ttlSec: 600,
      });
      const result = rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk,
      });
      expect(result.scope).toBe(scope);
      expect(verifySubToken(PARENT, result.subToken).scope).toBe(scope);
    }
  });

  it("inherits the remaining TTL from the old sub-token (exp carried over)", async () => {
    const jwk = await freshJwk();
    const now = 1_700_000_000_000;
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "approve-only",
      ttlSec: 600,
      now: () => now,
    });
    const result = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old,
      jwk,
      now: () => now + 250_000,
    });
    const oldExp = decodeClaims(old).exp;
    const newExp = decodeClaims(result.subToken).exp;
    expect(newExp).toBe(oldExp);
    expect(result.expiresAt).toBe(newExp * 1000);
  });

  it("returns distinct jti for old vs new (no reuse, log correlation works)", async () => {
    const jwk = await freshJwk();
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 600,
    });
    const result = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old,
      jwk,
    });
    expect(result.oldJti).toBe(decodeClaims(old).jti);
    expect(result.newJti).toBe(decodeClaims(result.subToken).jti);
    expect(result.oldJti).not.toBe(result.newJti);
  });
});

describe("rebindSubToken — error codes", () => {
  it("throws `parent_missing` when parentToken is empty", async () => {
    const jwk = await freshJwk();
    const dummyOld = mintSubToken({
      parentToken: "other-parent",
      scope: "read-only",
      ttlSec: 60,
    });
    expect(() =>
      rebindSubToken({
        parentToken: "",
        oldSubToken: dummyOld,
        jwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "parent_missing" }) as Error);
  });

  it("throws `old_malformed` when oldSubToken is empty", async () => {
    const jwk = await freshJwk();
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: "",
        jwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "old_malformed" }) as Error);
  });

  it("throws `old_malformed` when oldSubToken has no dot separator", async () => {
    const jwk = await freshJwk();
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: "garbage-without-dot",
        jwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "old_malformed" }) as Error);
  });

  it("throws `old_invalid` when oldSubToken signature does not match parent", async () => {
    const jwk = await freshJwk();
    // Mint under a different parent, then try to rebind under PARENT.
    const foreign = mintSubToken({
      parentToken: "different-parent",
      scope: "read-only",
      ttlSec: 60,
    });
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: foreign,
        jwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "old_invalid" }) as Error);
  });

  it("throws `old_expired` when oldSubToken exp is already in the past", async () => {
    const jwk = await freshJwk();
    const t0 = 1_700_000_000_000;
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
      now: () => t0,
    });
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk,
        now: () => t0 + 120_000, // 2 minutes later — TTL was only 60s
      }),
    ).toThrowError(expect.objectContaining({ code: "old_expired" }) as Error);
  });

  it("throws `already_bound` when oldSubToken already carries a cnf claim", async () => {
    const jwk = await freshJwk();
    const jwk2 = await freshJwk();
    const already = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 600,
      cnf: { jkt: computeJwkThumbprint(jwk) },
    });
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: already,
        jwk: jwk2,
      }),
    ).toThrowError(expect.objectContaining({ code: "already_bound" }) as Error);
  });

  it("throws `jwk_invalid` when jwk kty is wrong", async () => {
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const badJwk = {
      kty: "RSA",
      crv: "P-256",
      x: "abc",
      y: "def",
    } as unknown as EcP256Jwk;
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk: badJwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "jwk_invalid" }) as Error);
  });

  it("throws `jwk_invalid` when jwk crv is wrong", async () => {
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const badJwk = {
      kty: "EC",
      crv: "P-384",
      x: "abc",
      y: "def",
    } as unknown as EcP256Jwk;
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk: badJwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "jwk_invalid" }) as Error);
  });

  it("throws `jwk_invalid` when jwk.x is missing", async () => {
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const badJwk = {
      kty: "EC",
      crv: "P-256",
      x: "",
      y: "valid-y-coord",
    } as unknown as EcP256Jwk;
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk: badJwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "jwk_invalid" }) as Error);
  });

  it("throws `jwk_invalid` when jwk.y is missing", async () => {
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const badJwk = {
      kty: "EC",
      crv: "P-256",
      x: "valid-x-coord",
      y: "",
    } as unknown as EcP256Jwk;
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk: badJwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "jwk_invalid" }) as Error);
  });

  it("throws `jwk_private` when jwk carries a private scalar `d`", async () => {
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
    });
    const validJwk = await freshJwk();
    const privJwk = {
      ...validJwk,
      d: "private-scalar-must-be-rejected",
    } as unknown as EcP256Jwk;
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk: privJwk,
      }),
    ).toThrowError(expect.objectContaining({ code: "jwk_private" }) as Error);
  });
});

describe("rebindSubToken — jkt determinism", () => {
  it("same JWK → same jkt across multiple mints (RFC 7638 canonical form)", async () => {
    const jwk = await freshJwk();
    const expected = computeJwkThumbprint(jwk);
    // Two parallel rebinds with the same key must produce the same jkt
    // (the *tokens* differ — jti is random — but cnf.jkt is deterministic).
    const old1 = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 600,
    });
    const old2 = mintSubToken({
      parentToken: PARENT,
      scope: "approve-only",
      ttlSec: 600,
    });
    const r1 = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old1,
      jwk,
    });
    const r2 = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old2,
      jwk,
    });
    const c1 = verifySubToken(PARENT, r1.subToken);
    const c2 = verifySubToken(PARENT, r2.subToken);
    expect(c1.cnf?.jkt).toBe(expected);
    expect(c2.cnf?.jkt).toBe(expected);
    // Different scopes → different sub-tokens but same jkt.
    expect(r1.subToken).not.toBe(r2.subToken);
  });

  it("different JWKs → different jkt values (no collision under tampering)", async () => {
    const jwk1 = await freshJwk();
    const jwk2 = await freshJwk();
    expect(computeJwkThumbprint(jwk1)).not.toBe(computeJwkThumbprint(jwk2));
  });

  it("re-importing the same key yields an identical jkt (extra-vs-base members ignored)", async () => {
    const jwk = await freshJwk();
    const aliased: EcP256Jwk = {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      alg: "ES256", // extra member — RFC 7638 ignores it
      use: "sig",
    };
    expect(computeJwkThumbprint(aliased)).toBe(computeJwkThumbprint(jwk));
  });
});

describe("rebindSubToken — TTL boundary", () => {
  it("remainingTtl of exactly 1 second succeeds", async () => {
    const jwk = await freshJwk();
    const t0 = 1_700_000_000_000;
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
      now: () => t0,
    });
    // Mock the clock so exp is now+60s and we evaluate at now+59s — leaving
    // 1 full second of remaining TTL.
    const result = rebindSubToken({
      parentToken: PARENT,
      oldSubToken: old,
      jwk,
      now: () => t0 + 59_000,
    });
    expect(result.scope).toBe("read-only");
    const newClaims = decodeClaims(result.subToken);
    // New exp matches old exp (TTL inherited).
    const oldClaims = decodeClaims(old);
    expect(newClaims.exp).toBe(oldClaims.exp);
  });

  it("remainingTtl of zero — clock exactly at exp — fails with `old_expired`", async () => {
    const jwk = await freshJwk();
    const t0 = 1_700_000_000_000;
    const old = mintSubToken({
      parentToken: PARENT,
      scope: "read-only",
      ttlSec: 60,
      now: () => t0,
    });
    // Floor(t0/1000)+60 is the exp. We evaluate at exp*1000.
    expect(() =>
      rebindSubToken({
        parentToken: PARENT,
        oldSubToken: old,
        jwk,
        now: () => t0 + 60_000,
      }),
    ).toThrowError(expect.objectContaining({ code: "old_expired" }) as Error);
  });
});
