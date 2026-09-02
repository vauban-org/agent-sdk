/**
 * Integration test : DPoP gate on the HTTP server (P1b).
 *
 * Boots a real `createRemoteControlServer`, mints a device-bound
 * sub-token (cnf claim), then exercises :
 *   - sub-token without DPoP header → 401 dpop_required
 *   - sub-token with DPoP signed by WRONG key → 401 dpop_invalid (jkt)
 *   - sub-token with valid DPoP → 200
 *   - sub-token with replayed DPoP jti → 401 dpop_invalid (replayed)
 *   - parent token request skips the DPoP gate (founder local process)
 */

import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DpopReplayStore,
  type EcP256Jwk,
  type RemoteControlServerHandle,
  computeJwkThumbprint,
  createRemoteControlHub,
  createRemoteControlServer,
  mintSubToken,
} from "../../src/remote/index.js";

const subtle = (globalThis.crypto ?? webcrypto).subtle;

const PARENT_TOKEN = "dpop-int-test-parent";

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
  claims: { htm: string; htu: string; iat: number; jti: string; ath?: string },
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk };
  const headerB64 = b64urlEncodeStr(JSON.stringify(header));
  const payloadB64 = b64urlEncodeStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBuf = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return `${headerB64}.${payloadB64}.${Buffer.from(new Uint8Array(sigBuf)).toString("base64url")}`;
}

function parseUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) };
}

describe("P1b — DPoP gate on HTTP server", () => {
  let server: RemoteControlServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("rejects a cnf-bound sub-token without a DPoP header (401 dpop_required)", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
      publicBaseUrl: undefined, // exercise the header reconstruction path
    });
    const { port } = parseUrl(server.url);
    const { publicJwk } = await generateEcP256();
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt: computeJwkThumbprint(publicJwk) },
    });
    const resp = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}` },
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("dpop_required");
  });

  it("rejects a sub-token with DPoP signed by a different key (401 dpop_invalid, jkt)", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
    });
    const { port } = parseUrl(server.url);
    const kpA = await generateEcP256(); // bound
    const kpB = await generateEcP256(); // attacker
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt: computeJwkThumbprint(kpA.publicJwk) },
    });
    const proof = await signDpop(kpB.privateKey, kpB.publicJwk, {
      htm: "GET",
      htu: `http://127.0.0.1:${port}/remote/state`,
      iat: Math.floor(Date.now() / 1000),
      jti: "test-1",
    });
    const resp = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proof },
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string; detail: string };
    expect(body.error).toBe("dpop_invalid");
    expect(body.detail).toMatch(/jkt/);
  });

  it("accepts a sub-token with a valid DPoP proof (200)", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
    });
    const { port } = parseUrl(server.url);
    const { publicJwk, privateKey } = await generateEcP256();
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt: computeJwkThumbprint(publicJwk) },
    });
    const proof = await signDpop(privateKey, publicJwk, {
      htm: "GET",
      htu: `http://127.0.0.1:${port}/remote/state`,
      iat: Math.floor(Date.now() / 1000),
      jti: "test-ok",
    });
    const resp = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proof },
    });
    expect(resp.status).toBe(200);
  });

  it("rejects a replayed DPoP jti on the second request", async () => {
    const hub = createRemoteControlHub();
    const store = new DpopReplayStore();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
      dpopReplayStore: store,
    });
    const { port } = parseUrl(server.url);
    const { publicJwk, privateKey } = await generateEcP256();
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt: computeJwkThumbprint(publicJwk) },
    });
    const claims = {
      htm: "GET",
      htu: `http://127.0.0.1:${port}/remote/state`,
      iat: Math.floor(Date.now() / 1000),
      jti: "replay-me",
    };
    const proof = await signDpop(privateKey, publicJwk, claims);

    // First request — valid.
    const r1 = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proof },
    });
    expect(r1.status).toBe(200);

    // Second request — same proof, same jti → replay.
    const r2 = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proof },
    });
    expect(r2.status).toBe(401);
    const body = (await r2.json()) as { error: string; detail: string };
    expect(body.error).toBe("dpop_invalid");
    expect(body.detail).toMatch(/replay/);
  });

  it("parent token request skips the DPoP gate (founder local process)", async () => {
    // Even with no DPoP header AND the parent token holds full scope,
    // the parent never goes through the cnf-gate (only sub-tokens do).
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
    });
    const { port } = parseUrl(server.url);
    const resp = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${PARENT_TOKEN}` },
    });
    expect(resp.status).toBe(200);
  });

  it("publicBaseUrl override changes the expected htu", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
      publicBaseUrl: "https://api.public-host.example",
    });
    const { port } = parseUrl(server.url);
    const { publicJwk, privateKey } = await generateEcP256();
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 60,
      cnf: { jkt: computeJwkThumbprint(publicJwk) },
    });
    // Sign with the loopback htu — should fail htu match.
    const proofLoopback = await signDpop(privateKey, publicJwk, {
      htm: "GET",
      htu: `http://127.0.0.1:${port}/remote/state`,
      iat: Math.floor(Date.now() / 1000),
      jti: "wrong-htu",
    });
    const r1 = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proofLoopback },
    });
    expect(r1.status).toBe(401);
    const body = (await r1.json()) as { detail: string };
    expect(body.detail).toMatch(/htu/);

    // Sign with the public htu — should succeed.
    const proofPublic = await signDpop(privateKey, publicJwk, {
      htm: "GET",
      htu: "https://api.public-host.example/remote/state",
      iat: Math.floor(Date.now() / 1000),
      jti: "right-htu",
    });
    const r2 = await fetch(`http://127.0.0.1:${port}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}`, DPoP: proofPublic },
    });
    expect(r2.status).toBe(200);
  });
});
