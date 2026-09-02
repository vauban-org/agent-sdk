/**
 * Integration test : GET /remote/teammates (sprint-893 d1, ZD5).
 *
 * The route is opt-in via `RemoteControlServerOptions.teammateInfo` (same
 * structural-port discipline as `teammateSend`) : absent, the route 404s
 * exactly as a pre-d1 server would ; present, it serves the port's snapshot
 * behind the SAME read-only bearer-scope gate every other GET route uses.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type RemoteControlServerHandle,
  type TeammateInfoPort,
  type TeammateInfoSnapshot,
  createRemoteControlHub,
  createRemoteControlServer,
  mintSubToken,
} from "../../src/remote/index.js";

const TOKEN = "teammate-info-test-token";

function parseUrl(url: string): { port: number } {
  return { port: Number(new URL(url).port) };
}

const FIXTURE: TeammateInfoSnapshot = {
  peers: [{ peerId: "peer-1", label: "phone", pairedAt: "2026-07-06T00:00:00.000Z" }],
  sessions: [{ sessionId: "run-1", runIds: ["run-1"], task: "await-teammate" }],
  pendingAsksCount: 2,
};

function fakePort(snapshot: TeammateInfoSnapshot = FIXTURE): TeammateInfoPort {
  return { snapshot: async () => snapshot };
}

describe("GET /remote/teammates (sprint-893 d1)", () => {
  let server: RemoteControlServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("404s when no teammateInfo port is wired ; byte-identical to a pre-d1 server", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, { host: "127.0.0.1", port: 0, token: TOKEN });
    const { port } = parseUrl(server.url);

    const resp = await fetch(`http://127.0.0.1:${port}/remote/teammates`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status).toBe(404);
  });

  it("serves the wired port's snapshot verbatim", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      teammateInfo: fakePort(),
    });
    const { port } = parseUrl(server.url);

    const resp = await fetch(`http://127.0.0.1:${port}/remote/teammates`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as TeammateInfoSnapshot;
    expect(body).toEqual(FIXTURE);
  });

  it("a read-only scoped sub-token is sufficient ; full scope is not required", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      teammateInfo: fakePort(),
    });
    const { port } = parseUrl(server.url);

    const readOnly = mintSubToken({ parentToken: TOKEN, scope: "read-only", ttlSec: 3600 });
    const okResp = await fetch(`http://127.0.0.1:${port}/remote/teammates`, {
      headers: { Authorization: `Bearer ${readOnly}` },
    });
    expect(okResp.status).toBe(200);
  });

  it("rejects an unauthenticated request (no bearer) ; fail closed", async () => {
    const hub = createRemoteControlHub();
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      teammateInfo: fakePort(),
    });
    const { port } = parseUrl(server.url);

    const resp = await fetch(`http://127.0.0.1:${port}/remote/teammates`);
    expect(resp.status).toBe(401);
  });

  it("reflects an empty snapshot (no peers paired, no sessions, no pending asks) honestly", async () => {
    const hub = createRemoteControlHub();
    const empty: TeammateInfoSnapshot = { peers: [], sessions: [], pendingAsksCount: 0 };
    server = await createRemoteControlServer(hub, {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      teammateInfo: fakePort(empty),
    });
    const { port } = parseUrl(server.url);

    const resp = await fetch(`http://127.0.0.1:${port}/remote/teammates`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await resp.json()) as TeammateInfoSnapshot;
    expect(body).toEqual(empty);
  });
});
