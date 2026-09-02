/**
 * Unit tests for the host-side relay client (T2 sovereign relay).
 *
 * The E2E suite in `packages/preste-relay/tests/relay.test.ts` covers the
 * happy path against a live relay. This unit suite isolates the
 * `connectRelay` surface : behaviour when the relay POST fails, when the
 * SSE stream is unreachable, when the host closes the connection, and the
 * `isPaired()` lifecycle. We mock `globalThis.fetch` directly — no live
 * relay required.
 *
 * @since 2.12.0 — preste remote-control T2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELAY_PROTOCOL_VERSION,
  connectRelay,
  createRemoteControlHub,
  relayPaths,
} from "../../src/remote/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Build an empty SSE body that immediately closes — the host-stream
 * fetch returns this so `consumeSse` reaches `done=true` and exits
 * cleanly. We never plan to assert on SSE events here ; that path is
 * covered by the live-relay E2E suite.
 */
function emptySseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.close();
    },
  });
}

/** Build a minimal fetch mock with a queued registration response. */
function mockRegistration(): {
  fetch: ReturnType<typeof vi.fn>;
  reg: { sessionId: string; pairingToken: string; hostToken: string };
} {
  const reg = {
    sessionId: "test-session-id",
    pairingToken: "test-pairing-token",
    hostToken: "test-host-token",
  };
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith(relayPaths.session)) {
      return new Response(JSON.stringify(reg), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/host-stream")) {
      return new Response(emptySseBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // host-send (frame or close) — respond OK, no body required.
    return new Response("{}", { status: 200 });
  });
  return { fetch, reg };
}

describe("connectRelay — session registration", () => {
  it("returns a pairing payload with protocol version + host pubkey", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });
    expect(conn.pairing.v).toBe(RELAY_PROTOCOL_VERSION);
    expect(conn.pairing.sessionId).toBe("test-session-id");
    expect(conn.pairing.pairingToken).toBe("test-pairing-token");
    expect(conn.pairing.relayUrl).toBe("https://relay.example.test");
    expect(conn.pairing.hostPubKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    await conn.close();
  });

  it("strips trailing slashes from the relay URL", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test/",
      hub,
    });
    expect(conn.pairing.relayUrl).toBe("https://relay.example.test");
    // The actual POST went to the URL without the duplicate slash.
    const calls = fetch.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain(`https://relay.example.test${relayPaths.session}`);
    await conn.close();
  });

  it("starts unpaired — isPaired() is false until the guest joins", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });
    expect(conn.isPaired()).toBe(false);
    await conn.close();
  });

  it("throws when the relay session POST fails (non-2xx)", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
    ) as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    await expect(connectRelay({ relayUrl: "https://down.example.test", hub })).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("propagates network failures from the registration POST", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    await expect(connectRelay({ relayUrl: "https://offline.example.test", hub })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("includes the host public key in the registration body", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });

    const regCall = fetch.mock.calls.find((c) => String(c[0]).endsWith(relayPaths.session));
    expect(regCall).toBeDefined();
    if (regCall) {
      const init = regCall[1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as { hostPubKey: string };
      expect(body.hostPubKey).toBe(conn.pairing.hostPubKey);
    }
    await conn.close();
  });
});

describe("connectRelay — close()", () => {
  it("emits a X-Relay-Close best-effort POST when close() is called", async () => {
    const { fetch, reg } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });

    await conn.close();

    // The close path POSTs to host-send with the X-Relay-Close header.
    const closeCall = fetch.mock.calls.find((c) => {
      const url = String(c[0]);
      const init = c[1] as RequestInit | undefined;
      return (
        url.endsWith(relayPaths.hostSend(reg.sessionId)) &&
        init?.headers &&
        (init.headers as Record<string, string>)["X-Relay-Close"] === "1"
      );
    });
    expect(closeCall).toBeDefined();
  });

  it("swallows close-side fetch errors (best effort)", async () => {
    let regDone = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!regDone && url.endsWith(relayPaths.session)) {
        regDone = true;
        return new Response(
          JSON.stringify({
            sessionId: "s",
            pairingToken: "p",
            hostToken: "h",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/host-stream")) {
        return new Response(emptySseBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // host-send (close) throws — must be swallowed by close().
      if (url.includes("/host-send")) throw new Error("network blip");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it("close() is idempotent — calling twice does not throw", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const hub = createRemoteControlHub();
    const conn = await connectRelay({
      relayUrl: "https://relay.example.test",
      hub,
    });

    await conn.close();
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

describe("connectRelay — pairing payload shape", () => {
  let hub: ReturnType<typeof createRemoteControlHub>;

  beforeEach(() => {
    hub = createRemoteControlHub();
  });

  it("hostPubKey is a base64-encoded X25519 SPKI", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    const conn = await connectRelay({
      relayUrl: "https://r.test",
      hub,
    });
    // Base64 / base64url charset only.
    expect(conn.pairing.hostPubKey).toMatch(/^[A-Za-z0-9+/_=-]+$/);
    expect(conn.pairing.hostPubKey.length).toBeGreaterThan(20);
    await conn.close();
  });

  it("each call generates a fresh ephemeral keypair (no reuse)", async () => {
    const { fetch } = mockRegistration();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const c1 = await connectRelay({ relayUrl: "https://r.test", hub });
    const c2 = await connectRelay({ relayUrl: "https://r.test", hub });
    expect(c1.pairing.hostPubKey).not.toBe(c2.pairing.hostPubKey);
    await c1.close();
    await c2.close();
  });
});
