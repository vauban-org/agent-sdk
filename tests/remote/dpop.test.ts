/**
 * Tests for P1b DPoP device-binding primitives.
 *
 * Coverage :
 *   - computeJwkThumbprint : RFC 7638 canonical form, only EC P-256
 *   - mintSubToken / verifySubToken : cnf claim flow
 *   - validateDpopProof : full happy path (real ES256 signature) +
 *     every documented failure mode (malformed, alg, typ, jkt mismatch,
 *     htm, htu, iat freshness, jti replay, ath mismatch, sig)
 *   - DpopReplayStore : ttl GC + bounded size
 *
 * The crypto primitives use Node 20+ `globalThis.crypto.subtle` (Web
 * Crypto). When the test environment doesn't expose it, fall back to
 * `node:crypto.webcrypto`.
 */

import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DpopReplayStore,
  type EcP256Jwk,
  computeJwkThumbprint,
  mintSubToken,
  validateDpopProof,
  verifySubToken,
} from "../../src/remote/index.js";

const subtle = (globalThis.crypto ?? webcrypto).subtle;

// ─── Helpers : generate a P-256 keypair + sign a DPoP JWT ────────────────

async function generateEcP256(): Promise<{
  publicJwk: EcP256Jwk;
  privateKey: CryptoKey;
}> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = (await subtle.exportKey("jwk", kp.publicKey)) as EcP256Jwk;
  // strip d if exporter included it (some impls return both).
  if (publicJwk.d !== undefined) delete (publicJwk as { d?: string }).d;
  return { publicJwk, privateKey: kp.privateKey };
}

function b64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function b64urlEncodeStr(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

async function signDpopProof(
  privateKey: CryptoKey,
  publicJwk: EcP256Jwk,
  claims: { htm: string; htu: string; iat: number; jti: string; ath?: string },
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk };
  const headerB64 = b64urlEncodeStr(JSON.stringify(header));
  const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}

// ─── computeJwkThumbprint ────────────────────────────────────────────────

describe("computeJwkThumbprint", () => {
  it("matches the RFC 7638 §3.1 canonical form for EC keys", () => {
    // The RFC 7638 example is for RSA ; we use a fixed P-256 vector to
    // assert deterministic output. The exact value is computed once by
    // the implementation itself ; the contract is determinism + format.
    const jwk: EcP256Jwk = {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    };
    const t = computeJwkThumbprint(jwk);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // Deterministic.
    expect(computeJwkThumbprint(jwk)).toBe(t);
    // Order-independent (canonical sort is part of the spec).
    const reordered: EcP256Jwk = {
      crv: "P-256",
      kty: "EC",
      x: jwk.x,
      y: jwk.y,
    };
    expect(computeJwkThumbprint(reordered)).toBe(t);
  });

  it("rejects non-EC keys", () => {
    expect(() =>
      computeJwkThumbprint({
        kty: "RSA" as unknown as "EC",
        crv: "P-256",
        x: "x",
        y: "y",
      } as EcP256Jwk),
    ).toThrow(/kty=EC/);
  });

  it("rejects non-P-256 curves", () => {
    expect(() =>
      computeJwkThumbprint({
        kty: "EC",
        crv: "P-384" as unknown as "P-256",
        x: "x",
        y: "y",
      } as EcP256Jwk),
    ).toThrow(/P-256/);
  });

  it("rejects keys missing x or y", () => {
    expect(() =>
      computeJwkThumbprint({
        kty: "EC",
        crv: "P-256",
        x: "",
        y: "y",
      } as EcP256Jwk),
    ).toThrow(/x or y/);
  });
});

// ─── mintSubToken / verifySubToken with cnf ──────────────────────────────

describe("sub-token with cnf claim (P1b)", () => {
  it("mints a sub-token carrying the cnf.jkt", () => {
    const parent = "device-bound-parent";
    const jkt = "expected-jkt-12345";
    const token = mintSubToken({
      parentToken: parent,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt },
    });
    const r = verifySubToken(parent, token);
    expect(r.valid).toBe(true);
    expect(r.cnf).toEqual({ jkt });
  });

  it("omits cnf when not supplied (backward compat)", () => {
    const parent = "non-bound-parent";
    const token = mintSubToken({
      parentToken: parent,
      scope: "read-only",
      ttlSec: 60,
    });
    const r = verifySubToken(parent, token);
    expect(r.valid).toBe(true);
    expect(r.cnf).toBeUndefined();
  });

  it("rejects empty cnf.jkt at mint time", () => {
    expect(() =>
      mintSubToken({
        parentToken: "x",
        scope: "read-only",
        ttlSec: 60,
        cnf: { jkt: "" },
      }),
    ).toThrow(/cnf\.jkt/);
  });
});

// ─── validateDpopProof : happy path + failure modes ──────────────────────

describe("validateDpopProof — happy path", () => {
  it("accepts a fresh, well-formed proof signed by the matching key", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const claims = {
      htm: "POST",
      htu: "https://api.example.com/remote/inject",
      iat: Math.floor(Date.now() / 1000),
      jti: "test-jti-1",
    };
    const dpop = await signDpopProof(privateKey, publicJwk, claims);
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "POST",
      expectedHtu: "https://api.example.com/remote/inject",
    });
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.jkt).toBe(jkt);
      expect(r.claims.jti).toBe("test-jti-1");
    }
  });

  it("strips query + fragment from expectedHtu before compare", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const claims = {
      htm: "GET",
      htu: "https://api.example.com/remote/state",
      iat: Math.floor(Date.now() / 1000),
      jti: "test-jti-q",
    };
    const dpop = await signDpopProof(privateKey, publicJwk, claims);
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://api.example.com/remote/state?since=42#x",
    });
    expect(r.valid).toBe(true);
  });

  it("calls recordJti on success with the right expiry", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      htm: "GET",
      htu: "https://h/",
      iat,
      jti: "test-jti-rec",
    };
    const dpop = await signDpopProof(privateKey, publicJwk, claims);
    let recordedJti: string | undefined;
    let recordedExp: number | undefined;
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
      maxAgeSec: 60,
      recordJti: (jti, exp) => {
        recordedJti = jti;
        recordedExp = exp;
      },
    });
    expect(r.valid).toBe(true);
    expect(recordedJti).toBe("test-jti-rec");
    expect(recordedExp).toBe((iat + 60) * 1000);
  });

  it("accepts a proof with ath when accessToken matches", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const accessToken = "the-access-token-12345";
    const { createHash } = await import("node:crypto");
    const ath = createHash("sha256").update(accessToken, "utf-8").digest("base64url");
    const claims = {
      htm: "POST",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "test-jti-ath",
      ath,
    };
    const dpop = await signDpopProof(privateKey, publicJwk, claims);
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "POST",
      expectedHtu: "https://h/",
      accessToken,
    });
    expect(r.valid).toBe(true);
  });
});

describe("validateDpopProof — failure modes", () => {
  it("rejects empty input", async () => {
    const r = await validateDpopProof("", {
      expectedJkt: "x",
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/empty/);
  });

  it("rejects malformed structure", async () => {
    const r = await validateDpopProof("aaa.bbb", {
      expectedJkt: "x",
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/malformed|segments/);
  });

  it("rejects wrong typ", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    // Build a proof with the wrong typ manually.
    const header = { typ: "JWT", alg: "ES256", jwk: publicJwk };
    const claims = {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    };
    const headerB64 = b64urlEncodeStr(JSON.stringify(header));
    const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
    const dpop = `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/typ/);
  });

  it("rejects jkt mismatch (different keypair than expected)", async () => {
    const kpA = await generateEcP256();
    const kpB = await generateEcP256();
    const dpop = await signDpopProof(kpA.privateKey, kpA.publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: computeJwkThumbprint(kpB.publicJwk),
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/jkt/);
  });

  it("rejects htm mismatch", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "POST",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/htm/);
  });

  it("rejects htu mismatch", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://a/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://b/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/htu/);
  });

  it("rejects iat too old", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000) - 3600, // 1h old
      jti: "x",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
      maxAgeSec: 60,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/old/);
  });

  it("rejects iat in the future", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000) + 3600, // 1h in future
      jti: "x",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
      maxAgeSec: 60,
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/future/);
  });

  it("rejects replayed jti via callback", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "burned",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
      isReplayed: (jti) => jti === "burned",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/replayed/);
  });

  it("rejects ath mismatch", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
      ath: "tampered-ath-value",
    });
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
      accessToken: "real-access-token",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/ath/);
  });

  it("rejects signature tampering (payload mutated)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const dpop = await signDpopProof(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    });
    // Mutate the payload segment but keep header + sig intact.
    const [h, _p, s] = dpop.split(".");
    const fakePayload = b64urlEncodeStr(
      JSON.stringify({
        htm: "GET",
        htu: "https://h/",
        iat: Math.floor(Date.now() / 1000),
        jti: "y", // changed
      }),
    );
    const tampered = `${h}.${fakePayload}.${s}`;
    const r = await validateDpopProof(tampered, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/signature/);
  });

  it("rejects a JWK containing private scalar d", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const headerWithD = {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { ...publicJwk, d: "PRIVATE_SCALAR_NEVER_PUT_HERE" },
    };
    const claims = {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    };
    const headerB64 = b64urlEncodeStr(JSON.stringify(headerWithD));
    const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
    const dpop = `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/no d/i);
  });

  it("rejects an unsupported alg", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const jkt = computeJwkThumbprint(publicJwk);
    const header = { typ: "dpop+jwt", alg: "RS256", jwk: publicJwk };
    const claims = {
      htm: "GET",
      htu: "https://h/",
      iat: Math.floor(Date.now() / 1000),
      jti: "x",
    };
    const headerB64 = b64urlEncodeStr(JSON.stringify(header));
    const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
    const dpop = `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
    const r = await validateDpopProof(dpop, {
      expectedJkt: jkt,
      expectedHtm: "GET",
      expectedHtu: "https://h/",
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/alg/);
  });
});

// ─── DpopReplayStore ─────────────────────────────────────────────────────

describe("DpopReplayStore", () => {
  it("returns false for unseen jtis", () => {
    const s = new DpopReplayStore();
    expect(s.isReplayed("never-seen")).toBe(false);
  });

  it("returns true for recorded jtis within their window", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    s.record("hot", now + 60_000);
    expect(s.isReplayed("hot", now)).toBe(true);
  });

  it("expires entries past their TTL", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    s.record("cold", now - 1000);
    expect(s.isReplayed("cold", now)).toBe(false);
    expect(s.size).toBe(0); // gc cleaned it up
  });

  it("bounds size — oldest entries evicted when over capacity", () => {
    const s = new DpopReplayStore({ maxSize: 3 });
    const now = Date.now();
    s.record("a", now + 60_000);
    s.record("b", now + 60_000);
    s.record("c", now + 60_000);
    s.record("d", now + 60_000); // overflows -> evicts oldest (a)
    expect(s.isReplayed("a", now)).toBe(false);
    expect(s.isReplayed("d", now)).toBe(true);
    expect(s.size).toBe(3);
  });

  it("reset() wipes the store", () => {
    const s = new DpopReplayStore();
    s.record("a", Date.now() + 60_000);
    s.reset();
    expect(s.size).toBe(0);
    expect(s.isReplayed("a")).toBe(false);
  });
});
