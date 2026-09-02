/**
 * Integration test : revocation persistence across server restarts (P7).
 *
 * The critical security claim that gates Bastion verifier (P3) — a
 * sub-token revoked before its TTL elapsed MUST stay revoked even if
 * the `preste --remote` process is killed and restarted. Without
 * persistence, restart reset `revokedJtis` and the previously-revoked
 * sub-token would silently re-validate.
 *
 * This test exercises the real HTTP server + the InMemoryPersistencePort
 * (the persistence interface is the same as for SQLite — the integration
 * holds regardless of the backing store).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryPersistencePort,
  type RemoteControlServerHandle,
  createRemoteControlHub,
  createRemoteControlServer,
  mintSubToken,
} from "../../src/remote/index.js";

const PARENT_TOKEN = "integration-test-parent-secret-key";

describe("P7 — revocation persistence across server restarts", () => {
  let server: RemoteControlServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("a revoked jti stays revoked after server restart (shared persistence)", async () => {
    // Shared persistence backs both "incarnations" of the server.
    const persistence = new InMemoryPersistencePort();

    // First incarnation — boot, revoke a sub-token, shut down.
    const hub1 = createRemoteControlHub({ persistence });
    server = await createRemoteControlServer(hub1, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
      persistence,
    });
    const { port: port1 } = parseUrl(server.url);

    // Mint a sub-token + record its jti.
    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 3600,
    });
    const jti = decodeJti(subToken);

    // Sanity check : the sub-token works.
    let resp = await fetch(`http://127.0.0.1:${port1}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}` },
    });
    expect(resp.status).toBe(200);

    // Revoke it via the full-scope parent.
    resp = await fetch(`http://127.0.0.1:${port1}/remote/revoke/${jti}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PARENT_TOKEN}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { revoked: boolean; durable: boolean };
    expect(body.revoked).toBe(true);
    expect(body.durable).toBe(true);

    // It's now 401.
    resp = await fetch(`http://127.0.0.1:${port1}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}` },
    });
    expect(resp.status).toBe(401);

    // Shut down server one.
    await server.close();
    server = undefined;

    // ─── RESTART ──────────────────────────────────────────────────────
    // Fresh hub, fresh server, but SAME persistence (the on-disk DB
    // analog). The revocation must survive.
    const hub2 = createRemoteControlHub({ persistence });
    server = await createRemoteControlServer(hub2, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
      persistence,
    });
    const { port: port2 } = parseUrl(server.url);

    // The sub-token presented again — server must reject as still revoked.
    resp = await fetch(`http://127.0.0.1:${port2}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}` },
    });
    expect(resp.status).toBe(401);

    // Confirm the revocations list is populated from persistence.
    resp = await fetch(`http://127.0.0.1:${port2}/remote/revocations`, {
      headers: { Authorization: `Bearer ${PARENT_TOKEN}` },
    });
    const revs = (await resp.json()) as { jtis: string[] };
    expect(revs.jtis).toContain(jti);
  });

  it("server without persistence loses revocations on restart (the pre-P7 baseline)", async () => {
    // No persistence — exercises the legacy in-memory behavior.
    const hub1 = createRemoteControlHub();
    server = await createRemoteControlServer(hub1, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
    });
    const { port: port1 } = parseUrl(server.url);

    const subToken = mintSubToken({
      parentToken: PARENT_TOKEN,
      scope: "read-only",
      ttlSec: 3600,
    });
    const jti = decodeJti(subToken);

    let resp = await fetch(`http://127.0.0.1:${port1}/remote/revoke/${jti}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PARENT_TOKEN}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { durable: boolean };
    expect(body.durable).toBe(false); // explicit signal to operator

    await server.close();
    server = undefined;

    const hub2 = createRemoteControlHub();
    server = await createRemoteControlServer(hub2, {
      host: "127.0.0.1",
      port: 0,
      token: PARENT_TOKEN,
    });
    const { port: port2 } = parseUrl(server.url);

    // Revocation lost — sub-token is valid again. This is the pre-P7
    // attack vector that P7 closes.
    resp = await fetch(`http://127.0.0.1:${port2}/remote/state`, {
      headers: { Authorization: `Bearer ${subToken}` },
    });
    expect(resp.status).toBe(200);
  });

  it("server fails closed if persistence load throws on boot", async () => {
    const broken = new InMemoryPersistencePort();
    await broken.close(); // any further read throws.

    const hub = createRemoteControlHub();
    await expect(
      createRemoteControlServer(hub, {
        host: "127.0.0.1",
        port: 0,
        token: PARENT_TOKEN,
        persistence: broken,
      }),
    ).rejects.toThrow(/closed/);
  });
});

function parseUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) };
}

/** Extract the jti claim from a `payload.sig` sub-token (base64url JSON). */
function decodeJti(subToken: string): string {
  const [payloadB64] = subToken.split(".");
  if (!payloadB64) throw new Error("malformed sub-token");
  const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8",
  );
  const claims = JSON.parse(json) as { jti: string };
  return claims.jti;
}
