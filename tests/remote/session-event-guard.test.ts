/**
 * Tests for `looksLikeSessionEvent` — the permissive runtime guard added in
 * 2.27.0 alongside the dual-emission migration. The guard accepts events
 * emitted in EITHER legacy dotted-lowercase OR AG-UI canonical
 * UPPER_SNAKE_CASE form so a relay client / PWA handler can keep working
 * regardless of which mode the upstream hub is in.
 *
 * @since 2.27.0
 */

import { describe, expect, it } from "vitest";

import { __resetEventSeq, looksLikeSessionEvent, makeEvent } from "../../src/remote/index.js";

describe("looksLikeSessionEvent — legacy form acceptance", () => {
  it("accepts a well-formed legacy run.start event", () => {
    __resetEventSeq();
    const e = makeEvent("run.start", {
      runId: "r-1",
      agentId: "a-1",
      startedAt: new Date().toISOString(),
    });
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a well-formed legacy assistant.delta event", () => {
    __resetEventSeq();
    const e = makeEvent("assistant.delta", { text: "hi" });
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a well-formed legacy tool.call.end event", () => {
    __resetEventSeq();
    const e = makeEvent("tool.call.end", {
      callId: "c1",
      toolName: "ls",
      ok: true,
      resultPreview: "files...",
    });
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a well-formed legacy hitl.request event", () => {
    __resetEventSeq();
    const e = makeEvent("hitl.request", {
      requestId: "h1",
      action: "deploy",
      context: "{}",
    });
    expect(looksLikeSessionEvent(e)).toBe(true);
  });
});

describe("looksLikeSessionEvent — canonical form acceptance", () => {
  // Canonical events are NOT produced via `makeEvent` (which is legacy-
  // typed) ; we construct them directly to simulate what an upstream
  // hub configured with `eventNaming: "canonical"` would put on the wire.

  it("accepts a canonical RUN_STARTED envelope", () => {
    const e = {
      type: "RUN_STARTED",
      id: "evt_abc",
      seq: 0,
      ts: new Date().toISOString(),
      data: {
        runId: "r-1",
        agentId: "a-1",
        startedAt: new Date().toISOString(),
      },
    };
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a canonical TEXT_MESSAGE_CONTENT envelope", () => {
    const e = {
      type: "TEXT_MESSAGE_CONTENT",
      id: "evt_b",
      seq: 1,
      ts: new Date().toISOString(),
      data: { text: "hi" },
    };
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a canonical TOOL_CALL_END envelope", () => {
    const e = {
      type: "TOOL_CALL_END",
      id: "evt_c",
      seq: 2,
      ts: new Date().toISOString(),
      data: {
        callId: "c1",
        toolName: "ls",
        ok: true,
        resultPreview: "files...",
      },
    };
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a canonical CUSTOM_HITL_REQUEST envelope (Vauban projection)", () => {
    const e = {
      type: "CUSTOM_HITL_REQUEST",
      id: "evt_d",
      seq: 3,
      ts: new Date().toISOString(),
      data: { requestId: "h1", action: "deploy", context: "{}" },
    };
    expect(looksLikeSessionEvent(e)).toBe(true);
  });

  it("accepts a canonical RUN_FINISHED envelope", () => {
    const e = {
      type: "RUN_FINISHED",
      id: "evt_e",
      seq: 4,
      ts: new Date().toISOString(),
      data: {
        runId: "r-1",
        stopReason: "ok",
        stepCount: 1,
        costUsd: 0,
        finishedAt: new Date().toISOString(),
      },
    };
    expect(looksLikeSessionEvent(e)).toBe(true);
  });
});

describe("looksLikeSessionEvent — rejection cases", () => {
  it("rejects null", () => {
    expect(looksLikeSessionEvent(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(looksLikeSessionEvent(undefined)).toBe(false);
  });

  it("rejects a primitive string", () => {
    expect(looksLikeSessionEvent("not an event")).toBe(false);
  });

  it("rejects a number", () => {
    expect(looksLikeSessionEvent(42)).toBe(false);
  });

  it("rejects an empty object", () => {
    expect(looksLikeSessionEvent({})).toBe(false);
  });

  it("rejects an event with unknown type", () => {
    expect(
      looksLikeSessionEvent({
        type: "totally.unknown",
        id: "evt_x",
        seq: 0,
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });

  it("rejects an event missing the id field", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        seq: 0,
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });

  it("rejects an event missing the seq field", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        id: "x",
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });

  it("rejects an event with seq as a string", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        id: "x",
        seq: "0",
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });

  it("rejects an event with seq as NaN", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        id: "x",
        seq: Number.NaN,
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });

  it("rejects an event missing the data field", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        id: "x",
        seq: 0,
        ts: "",
      }),
    ).toBe(false);
  });

  it("rejects an event with data as null", () => {
    expect(
      looksLikeSessionEvent({
        type: "run.start",
        id: "x",
        seq: 0,
        ts: "",
        data: null,
      }),
    ).toBe(false);
  });

  it("rejects an event with case-twisted type (mixed-case)", () => {
    expect(
      looksLikeSessionEvent({
        type: "Run.Start",
        id: "x",
        seq: 0,
        ts: "",
        data: {},
      }),
    ).toBe(false);
  });
});

describe("looksLikeSessionEvent — interop scenarios", () => {
  it("a relay handler can accept both forms from the same stream", () => {
    // Simulating a stream that mixes legacy + canonical events (e.g. a
    // proxy bridging a 2.27.0 legacy-mode hub with a 2.27.0 canonical-mode
    // hub).
    const events: unknown[] = [
      {
        type: "RUN_STARTED",
        id: "1",
        seq: 0,
        ts: "x",
        data: { runId: "r" },
      },
      {
        type: "assistant.delta",
        id: "2",
        seq: 1,
        ts: "x",
        data: { text: "hi" },
      },
      {
        type: "TOOL_CALL_START",
        id: "3",
        seq: 2,
        ts: "x",
        data: { callId: "c", toolName: "t", argsPreview: "" },
      },
    ];
    for (const e of events) expect(looksLikeSessionEvent(e)).toBe(true);
  });
});
