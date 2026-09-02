/**
 * Integration test : POST /teammate/events (SP1 event-push, symmetric to
 * /teammate/send). Opt-in via RemoteControlServerOptions.teammateEventSink ;
 * absent, the route 404s. The route sits BEFORE the bearer auth gate because
 * the signed SessionEvent is the credential (verified by the wired port).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  type RemoteControlServerHandle,
  type TeammateEventSinkPort,
  createRemoteControlHub,
  createRemoteControlServer,
} from "../../src/remote/index.js";

const TOKEN = "events-route-test-token";

function parsePort(url: string): number {
  return Number(new URL(url).port);
}

describe("POST /teammate/events (SP1)", () => {
  let server: RemoteControlServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("404s when no teammateEventSink port is wired ; byte-identical to a pre-SP1 server", async () => {
    server = await createRemoteControlServer(createRemoteControlHub(), {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
    });
    const resp = await fetch(`http://127.0.0.1:${parsePort(server.url)}/teammate/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "STEP_STARTED", id: "e1", seq: 1, ts: "t", data: {} }),
    });
    expect(resp.status).toBe(404);
  });

  it("accepts a pushed event through the wired port WITHOUT the bearer gate", async () => {
    const received: unknown[] = [];
    const sink: TeammateEventSinkPort = {
      receivePushedEvent: async (event) => {
        received.push(event);
        return { accepted: true };
      },
    };
    server = await createRemoteControlServer(createRemoteControlHub(), {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN, // a token IS set, yet the route must not require it
      teammateEventSink: sink,
    });
    const event = { type: "STEP_STARTED", id: "e1", seq: 1, ts: "t", data: {}, sig: "ab" };
    const resp = await fetch(`http://127.0.0.1:${parsePort(server.url)}/teammate/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // NO Authorization header
      body: JSON.stringify(event),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ accepted: true });
    expect(received).toHaveLength(1);
  });

  it("maps a rejected event to 401 fail-closed", async () => {
    const sink: TeammateEventSinkPort = {
      receivePushedEvent: async () => ({ accepted: false, errorName: "InvalidSignatureError" }),
    };
    server = await createRemoteControlServer(createRemoteControlHub(), {
      host: "127.0.0.1",
      port: 0,
      teammateEventSink: sink,
    });
    const resp = await fetch(`http://127.0.0.1:${parsePort(server.url)}/teammate/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "STEP_STARTED", id: "e1", seq: 1, ts: "t", data: {} }),
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ accepted: false, error: "InvalidSignatureError" });
  });

  it("400s on a malformed JSON body", async () => {
    const sink: TeammateEventSinkPort = {
      receivePushedEvent: async () => ({ accepted: true }),
    };
    server = await createRemoteControlServer(createRemoteControlHub(), {
      host: "127.0.0.1",
      port: 0,
      teammateEventSink: sink,
    });
    const resp = await fetch(`http://127.0.0.1:${parsePort(server.url)}/teammate/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(resp.status).toBe(400);
  });
});
