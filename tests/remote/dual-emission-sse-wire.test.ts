/**
 * Wire-level integration tests for the 3.0.0 canonical-only SSE emission.
 *
 * The unit suite (`event-name-map.test.ts`) covers the translator in
 * isolation. The conformance suite (`agent-sdk-conformance`) covers the
 * canary against the AG-UI runner. This file targets the in-between:
 * the full SSE wire from a real `createRemoteControlServer` over a hub.
 * We parse the SSE bytes by hand and assert:
 *   - every received event `type` field is in `ALL_KNOWN_EVENT_TYPES`
 *   - the type is exclusively in the canonical UPPER_SNAKE_CASE subset
 *   - backlog replay (via `?since=N`) preserves the canonical vocabulary
 *   - the `event:` SSE prefix mirrors the JSON `data.type` field per server
 *   - legacy dotted-lowercase inputs are normalised to canonical at emit
 *
 * @since 3.0.0
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ALL_KNOWN_EVENT_TYPES,
  type RemoteControlServerHandle,
  __resetEventSeq,
  createRemoteControlHub,
  createRemoteControlServer,
  makeEvent,
} from "../../src/remote/index.js";

const TOKEN = "wire-fixture-tok-v2";

const CANONICAL_TYPES = new Set([
  "RUN_STARTED",
  "STEP_STARTED",
  "RUN_FINISHED",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "CUSTOM_TOOL_INTENT",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "CUSTOM_HITL_REQUEST",
  "CUSTOM_HITL_RESOLVED",
  "CUSTOM_INSTRUCTION_INJECTED",
  "STATE_SNAPSHOT",
]);

interface ParsedSseFrame {
  event: string;
  data: { type?: string; seq?: number; id?: string } & Record<string, unknown>;
}

/**
 * Parse SSE bytes the same way the AG-UI conformance runner does: split on
 * blank line, then split each frame on '\n' looking for `event:` / `data:`
 * prefixes. We strip exactly one leading space per spec.
 */
function parseSseBlob(blob: string): ParsedSseFrame[] {
  const frames = blob.split("\n\n").filter((f) => f.trim() !== "");
  const out: ParsedSseFrame[] = [];
  for (const frame of frames) {
    let evt = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        evt = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    let parsed: ParsedSseFrame["data"] = {};
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      parsed = {};
    }
    out.push({ event: evt, data: parsed });
  }
  return out;
}

/**
 * Connect to a server with fetch, read the SSE backlog, then abort after a
 * short window. The server keeps the connection open for live events; we
 * only care about the buffered replay for these wire tests.
 */
async function readSseBacklog(
  url: string,
  bearer: string,
  windowMs = 200,
): Promise<ParsedSseFrame[]> {
  const ctrl = new AbortController();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: ctrl.signal,
  });
  if (!resp.body) {
    ctrl.abort();
    return [];
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let blob = "";
  const deadline = Date.now() + windowMs;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 50),
        ),
      ]);
      if (result.done) break;
      if (result.value) blob += decoder.decode(result.value, { stream: true });
    }
  } catch {
    // abort fires here; ignore
  }
  try {
    ctrl.abort();
  } catch {
    /* noop */
  }
  return parseSseBlob(blob);
}

function primeRepresentativeEvents(hub: ReturnType<typeof createRemoteControlHub>): void {
  hub.emit(
    makeEvent("run.start", {
      runId: "r-wire",
      agentId: "fixture",
      startedAt: new Date().toISOString(),
    }),
  );
  hub.emit(
    makeEvent("run.step", {
      stepIndex: 0,
      inputTokens: 2,
      outputTokens: 1,
      costUsd: 0,
    }),
  );
  // NOTE: no assistant.delta here ; TEXT_MESSAGE_CONTENT deltas are ephemeral
  // (C2, session-dans-la-poche) : broadcast live but never buffered, so they
  // never appear in the ?since= backlog these wire tests read. The buffered
  // durable record of an assistant message is TEXT_MESSAGE_END. The
  // ephemeral-vs-buffered contract itself is asserted below.
  hub.emit(makeEvent("assistant.message", { content: "stream" }));
  hub.emit(
    makeEvent("tool.call.start", {
      callId: "c1",
      toolName: "ls",
      argsPreview: "",
    }),
  );
  hub.emit(
    makeEvent("tool.call.end", {
      callId: "c1",
      toolName: "ls",
      ok: true,
      resultPreview: "ok",
    }),
  );
  hub.emit(
    makeEvent("run.finished", {
      runId: "r-wire",
      stopReason: "ok",
      stepCount: 1,
      costUsd: 0,
      finishedAt: new Date().toISOString(),
    }),
  );
}

describe("canonical SSE wire (3.0.0 — canonical-only mode)", () => {
  let server: RemoteControlServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("emits every event type in the canonical vocabulary subset", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 64 });
    primeRepresentativeEvents(hub);
    server = await createRemoteControlServer(hub, {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
    });
    const frames = await readSseBacklog(`${server.url}/remote/stream`, TOKEN, 300);
    // 6 durable events primed (the ephemeral delta is never buffered).
    expect(frames.length).toBeGreaterThanOrEqual(6);
    for (const f of frames) {
      const t = String(f.data.type);
      expect(ALL_KNOWN_EVENT_TYPES.has(t)).toBe(true);
      expect(CANONICAL_TYPES.has(t)).toBe(true);
    }
  });

  it("aligns the SSE `event:` prefix with the JSON `data.type` field", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 64 });
    primeRepresentativeEvents(hub);
    server = await createRemoteControlServer(hub, {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
    });
    const frames = await readSseBacklog(`${server.url}/remote/stream`, TOKEN, 300);
    for (const f of frames) {
      expect(f.event).toBe(String(f.data.type));
    }
  });

  it("preserves canonical names through ?since=N backlog replay", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 64 });
    primeRepresentativeEvents(hub);
    server = await createRemoteControlServer(hub, {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
    });
    // Skip the first 2 events via ?since=1 (seq 0 + 1).
    const frames = await readSseBacklog(`${server.url}/remote/stream?since=1`, TOKEN, 300);
    // 4 remaining events (TEXT_MESSAGE_END, TOOL_CALL_START, TOOL_CALL_END,
    // RUN_FINISHED) all in canonical form. No TEXT_MESSAGE_CONTENT : deltas are
    // ephemeral (never buffered), so a backlog replay never carries one.
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) {
      const t = String(f.data.type);
      expect(CANONICAL_TYPES.has(t)).toBe(true);
    }
    // seq monotonic + strictly > 1
    const seqs = frames.map((f) => Number(f.data.seq));
    for (const s of seqs) expect(s).toBeGreaterThan(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
    }
  });

  it("translates Vauban extensions onto CUSTOM_* on the wire", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 32 });
    hub.emit(
      makeEvent("hitl.request", {
        requestId: "h1",
        action: "deploy",
        context: "{}",
      }),
    );
    hub.emit(
      makeEvent("hitl.resolved", {
        requestId: "h1",
        approved: true,
        by: "remote",
      }),
    );
    hub.emit(
      makeEvent("tool.intent", {
        callId: "c2",
        toolName: "rm",
        argsPreview: "/tmp/foo",
        vetoWindowMs: 1000,
      }),
    );
    hub.emit(
      makeEvent("instruction.injected", {
        text: "go slower",
        source: "remote",
        whisper: false,
      }),
    );
    server = await createRemoteControlServer(hub, {
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
    });
    const frames = await readSseBacklog(`${server.url}/remote/stream`, TOKEN, 300);
    const types = frames.map((f) => String(f.data.type));
    expect(types).toContain("CUSTOM_HITL_REQUEST");
    expect(types).toContain("CUSTOM_HITL_RESOLVED");
    expect(types).toContain("CUSTOM_TOOL_INTENT");
    expect(types).toContain("CUSTOM_INSTRUCTION_INJECTED");
    for (const t of types) expect(t.startsWith("CUSTOM_")).toBe(true);
  });
});

describe("canonical SSE wire ; hub normalisation invariants", () => {
  it("legacy dotted input is normalised to canonical before buffering", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 4 });
    hub.emit(
      makeEvent("run.start", {
        runId: "r-norm",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    const buf = hub.backlog();
    expect(buf.length).toBe(1);
    expect(buf[0].type).toBe("RUN_STARTED");
  });

  it("canonical input passes through unchanged", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 4 });
    const upstream = {
      type: "TOOL_CALL_START",
      id: "evt_y",
      seq: 0,
      ts: new Date().toISOString(),
      data: { callId: "c", toolName: "ls", argsPreview: "" },
    } as unknown as Parameters<typeof hub.emit>[0];
    hub.emit(upstream);
    const buf = hub.backlog();
    expect(buf.length).toBe(1);
    expect(buf[0].type).toBe("TOOL_CALL_START");
  });

  it("broadcasts deltas live under their canonical name but never buffers them (ephemeral)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 4 });
    const live: string[] = [];
    hub.subscribe((e) => live.push(e.type));

    // C2 (session-dans-la-poche) : TEXT_MESSAGE_CONTENT deltas reach live
    // subscribers, canonicalised at the emit boundary, but stay OUT of the ring.
    hub.emit(makeEvent("assistant.delta", { text: "a" }));
    hub.emit(makeEvent("assistant.delta", { text: "b" }));
    expect(live).toEqual(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT"]);
    expect(hub.backlog()).toHaveLength(0);

    // A durable assistant message IS buffered, under its canonical name.
    hub.emit(makeEvent("assistant.message", { content: "done" }));
    expect(hub.backlog().map((e) => e.type)).toEqual(["TEXT_MESSAGE_END"]);
  });

  it("a single hub maintains exactly one logical event per emit (no double-emission)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 8 });
    hub.emit(
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      }),
    );
    // One emit; one buffered frame. No duplicate under either name.
    expect(hub.backlog()).toHaveLength(1);
    expect(hub.backlog()[0].type).toBe("STEP_STARTED");
  });
});
