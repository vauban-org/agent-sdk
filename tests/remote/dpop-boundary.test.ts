/**
 * Boundary tests for the DPoP gate ; clock skew, jti GC, ath cross-binding.
 *
 * The integration suite (`dpop-server-integration.test.ts`) covers the
 * happy/forbidden path through the HTTP server. The unit suite
 * (`dpop.test.ts`) drives `validateDpopProof` directly. This file pins
 * down the three boundaries that fix the contract in stone :
 *
 *   1. Clock skew window ; the validator's `maxAgeSec` default is 60s ;
 *      a proof at exactly the window boundary is accepted ; one second
 *      past the boundary is rejected.
 *   2. jti uniqueness over the GC sweep ; a jti rejected as replay can
 *      be re-used after its TTL has lapsed and the store has GC'd it.
 *   3. `ath` claim ; cross-binding the proof to the access token MUST
 *      be enforced when ath is present ; absence is permitted (per
 *      RFC 9449 §4.3 "if used").
 *
 * @since 2.27.0
 */

import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DpopReplayStore,
  type EcP256Jwk,
  computeJwkThumbprint,
  validateDpopProof,
} from "../../src/remote/index.js";

const subtle = (globalThis.crypto ?? webcrypto).subtle;

function b64urlEncodeStr(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

async function generateEcP256(): Promise<{
  publicJwk: EcP256Jwk;
  privateKey: CryptoKey;
}> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = (await subtle.exportKey("jwk", kp.publicKey)) as EcP256Jwk;
  if (publicJwk.d !== undefined) delete (publicJwk as { d?: string }).d;
  return { publicJwk, privateKey: kp.privateKey };
}

async function signDpop(
  privateKey: CryptoKey,
  publicJwk: EcP256Jwk,
  claims: {
    htm: string;
    htu: string;
    iat: number;
    jti: string;
    ath?: string;
  },
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk };
  const headerB64 = b64urlEncodeStr(JSON.stringify(header));
  const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return `${headerB64}.${payloadB64}.${Buffer.from(new Uint8Array(sigBuf)).toString("base64url")}`;
}

const HTM = "GET";
const HTU = "http://127.0.0.1:7777/remote/state";

describe("DPoP boundary ; clock skew window", () => {
  it("accepts a proof issued exactly at now (within window)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "edge-now",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a proof at exactly the maxAge boundary (now - 60s)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000) - 60,
      jti: "edge-boundary",
    });
    // Default maxAgeSec is 60 ; iat exactly at now-60s is `iat >= now-maxAge`
    // → not "too old" by the strict `<` comparison.
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a proof one second past the maxAge boundary (now - 61s)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000) - 61,
      jti: "edge-past",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/too old/);
  });

  it("rejects a proof slightly in the future beyond skew tolerance", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000) + 61,
      jti: "edge-future",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/future/);
  });

  it("accepts a proof at the +60s ceiling (clock-skew tolerant)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000) + 60,
      jti: "edge-future-ok",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("custom maxAgeSec narrows the window symmetrically", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    // 5-second window — anything older is rejected.
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000) - 6,
      jti: "tight-window",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      maxAgeSec: 5,
      now: () => nowMs,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/too old/);
  });
});

describe("DPoP boundary ; jti uniqueness across GC sweep", () => {
  it("rejects an exact-replay jti within the freshness window", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const store = new DpopReplayStore();
    const nowMs = 1_700_000_000_000;
    const claims = {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "replay-same",
    };
    const proof = await signDpop(privateKey, publicJwk, claims);

    // First — record the jti.
    const r1 = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
      isReplayed: (j) => store.isReplayed(j, nowMs),
      recordJti: (j, exp) => store.record(j, exp),
    });
    expect(r1.valid).toBe(true);

    // Second — same jti within window → replayed.
    const r2 = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
      isReplayed: (j) => store.isReplayed(j, nowMs),
      recordJti: (j, exp) => store.record(j, exp),
    });
    expect(r2.valid).toBe(false);
    if (!r2.valid) expect(r2.reason).toMatch(/replay/);
  });

  it("a previously-seen jti CAN be re-used after the store has GC'd it", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const store = new DpopReplayStore();
    const nowMs = 1_700_000_000_000;
    // Record a jti with the canonical 60s window.
    store.record("recycle-me", nowMs + 60_000);
    // Advance the wall clock past expiry.
    const laterMs = nowMs + 61_000;
    // From the store's perspective at laterMs, the entry has expired ; a
    // fresh proof carrying the same jti is acceptable.
    expect(store.isReplayed("recycle-me", laterMs)).toBe(false);

    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(laterMs / 1000),
      jti: "recycle-me",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => laterMs,
      isReplayed: (j) => store.isReplayed(j, laterMs),
      recordJti: (j, exp) => store.record(j, exp),
    });
    expect(result.valid).toBe(true);
  });

  it("two DIFFERENT jtis on the same key + same window are both accepted", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const store = new DpopReplayStore();
    // Use real wall-clock nowMs so the store's internal gcExpired(Date.now())
    // does not silently drop entries whose expiresAtMs are computed from
    // an injected pseudo-clock in the past.
    const nowMs = Date.now();
    for (const jti of ["jti-A", "jti-B"]) {
      const proof = await signDpop(privateKey, publicJwk, {
        htm: HTM,
        htu: HTU,
        iat: Math.floor(nowMs / 1000),
        jti,
      });
      const result = await validateDpopProof(proof, {
        expectedJkt: computeJwkThumbprint(publicJwk),
        expectedHtm: HTM,
        expectedHtu: HTU,
        now: () => nowMs,
        isReplayed: (j) => store.isReplayed(j, nowMs),
        recordJti: (j, exp) => store.record(j, exp),
      });
      expect(result.valid).toBe(true);
    }
    expect(store.size).toBe(2);
  });

  it("isReplayed callback returning true short-circuits even with a fresh signature", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "host-says-replayed",
    });
    // Host-side store has already seen this jti regardless of signature.
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
      isReplayed: () => true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/replay/);
  });
});

describe("DPoP boundary ; access-token cross-binding (ath claim)", () => {
  it("accepts a proof with NO ath claim when no accessToken is supplied", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "no-ath",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a proof with NO ath claim even when accessToken is supplied (ath is optional)", async () => {
    // Per RFC 9449 §4.3 ath is "if used" : the server doesn't reject when
    // absent ; cnf.jkt is the strong binding.
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "absent-ath",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      accessToken: "some-bearer-here",
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a proof with a correctly-computed ath claim", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const accessToken = "tok-abc-xyz";
    const ath = Buffer.from(
      await subtle.digest("SHA-256", new TextEncoder().encode(accessToken)),
    ).toString("base64url");

    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "ath-ok",
      ath,
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      accessToken,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a proof with an ath claim that does NOT match the token", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    // ath computed for token "real" ; we pass token "different" to validate.
    const realToken = "real-token";
    const ath = Buffer.from(
      await subtle.digest("SHA-256", new TextEncoder().encode(realToken)),
    ).toString("base64url");

    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "ath-mismatch",
      ath,
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      accessToken: "different-token",
      now: () => nowMs,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/ath mismatch/);
  });

  it("accepts a proof carrying ath when no accessToken is supplied to validator", async () => {
    // ath is present on the proof but the validator has no token to compare
    // against. Per the implementation, the check is skipped — validator
    // returns valid. (The caller is responsible for invoking with the
    // accessToken when ath enforcement is required.)
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const ath = Buffer.from(
      await subtle.digest("SHA-256", new TextEncoder().encode("anything")),
    ).toString("base64url");
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "ath-no-token",
      ath,
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });

  it("ignores an empty-string ath claim (treated as absent)", async () => {
    const { publicJwk, privateKey } = await generateEcP256();
    const nowMs = 1_700_000_000_000;
    const proof = await signDpop(privateKey, publicJwk, {
      htm: HTM,
      htu: HTU,
      iat: Math.floor(nowMs / 1000),
      jti: "ath-empty",
      ath: "",
    });
    const result = await validateDpopProof(proof, {
      expectedJkt: computeJwkThumbprint(publicJwk),
      expectedHtm: HTM,
      expectedHtu: HTU,
      accessToken: "any-token",
      now: () => nowMs,
    });
    expect(result.valid).toBe(true);
  });
});
