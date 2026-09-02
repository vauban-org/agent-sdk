/**
 * Tests for the `SessionEventSink` primitives : `NOOP_SESSION_SINK` + `teeSink`.
 *
 * The sink is the seam between the agent loop (producer) and any transport
 * (consumer). Two invariants are non-negotiable :
 *   1. emit() MUST NOT throw — a broken observer never crashes the run.
 *   2. emit() MUST NOT block — observers must not stall the hot path.
 *
 * @since 2.26.0
 */

import { describe, expect, it } from "vitest";
import {
  NOOP_SESSION_SINK,
  type SessionEvent,
  type SessionEventSink,
  __resetEventSeq,
  makeEvent,
  teeSink,
} from "../../src/remote/index.js";

function collector(): {
  sink: SessionEventSink;
  events: SessionEvent[];
} {
  const events: SessionEvent[] = [];
  return {
    sink: {
      emit(e: SessionEvent): void {
        events.push(e);
      },
    },
    events,
  };
}

describe("NOOP_SESSION_SINK", () => {
  it("emit() returns void without throwing", () => {
    __resetEventSeq();
    const e = makeEvent("assistant.message", { content: "noop" });
    expect(() => NOOP_SESSION_SINK.emit(e)).not.toThrow();
  });

  it("emit() is callable repeatedly with any event type", () => {
    __resetEventSeq();
    const events: SessionEvent[] = [
      makeEvent("run.start", {
        runId: "r",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      }),
      makeEvent("hitl.request", {
        requestId: "h",
        action: "x",
        context: "{}",
      }),
    ];
    for (const e of events) {
      expect(() => NOOP_SESSION_SINK.emit(e)).not.toThrow();
    }
  });
});

describe("teeSink — basic fan-out", () => {
  it("forwards each event to every sink", () => {
    __resetEventSeq();
    const a = collector();
    const b = collector();
    const c = collector();
    const tee = teeSink(a.sink, b.sink, c.sink);
    const e1 = makeEvent("assistant.message", { content: "1" });
    const e2 = makeEvent("assistant.message", { content: "2" });
    tee.emit(e1);
    tee.emit(e2);
    expect(a.events.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(b.events.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(c.events.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
  });

  it("teeSink() with no children is a no-op (does not throw on emit)", () => {
    __resetEventSeq();
    const tee = teeSink();
    expect(() => tee.emit(makeEvent("assistant.message", { content: "alone" }))).not.toThrow();
  });

  it("teeSink() with a single child behaves identically to that child", () => {
    __resetEventSeq();
    const c = collector();
    const tee = teeSink(c.sink);
    tee.emit(makeEvent("assistant.message", { content: "one" }));
    expect(c.events).toHaveLength(1);
  });
});

describe("teeSink — error isolation", () => {
  it("a throwing child does not prevent the sibling from receiving the event", () => {
    __resetEventSeq();
    const survivor = collector();
    let brokenCalls = 0;
    const broken: SessionEventSink = {
      emit(): void {
        brokenCalls++;
        throw new Error("observer blew up");
      },
    };
    const tee = teeSink(broken, survivor.sink);
    tee.emit(makeEvent("assistant.message", { content: "1" }));
    tee.emit(makeEvent("assistant.message", { content: "2" }));
    // Broken sink threw twice (no removal — unlike RemoteControlHub semantics).
    expect(brokenCalls).toBe(2);
    // Survivor received both events.
    expect(survivor.events).toHaveLength(2);
  });

  it("multiple throwing children all swallowed, order of healthy children preserved", () => {
    __resetEventSeq();
    const seen: string[] = [];
    const broken1: SessionEventSink = {
      emit(): void {
        throw new Error("b1");
      },
    };
    const healthy1: SessionEventSink = {
      emit(e: SessionEvent): void {
        seen.push(`h1-${e.seq}`);
      },
    };
    const broken2: SessionEventSink = {
      emit(): void {
        throw new Error("b2");
      },
    };
    const healthy2: SessionEventSink = {
      emit(e: SessionEvent): void {
        seen.push(`h2-${e.seq}`);
      },
    };
    const tee = teeSink(broken1, healthy1, broken2, healthy2);
    const e = makeEvent("assistant.message", { content: "x" });
    expect(() => tee.emit(e)).not.toThrow();
    expect(seen).toEqual([`h1-${e.seq}`, `h2-${e.seq}`]);
  });

  it("a synchronously-throwing first child does not abort the loop", () => {
    __resetEventSeq();
    const seen: SessionEvent[] = [];
    const tee = teeSink(
      {
        emit(): void {
          throw new TypeError("first");
        },
      },
      {
        emit(e: SessionEvent): void {
          seen.push(e);
        },
      },
    );
    tee.emit(makeEvent("assistant.message", { content: "ordering" }));
    expect(seen).toHaveLength(1);
  });
});

describe("teeSink — composability", () => {
  it("nesting tees forwards transitively to every leaf", () => {
    __resetEventSeq();
    const a = collector();
    const b = collector();
    const c = collector();
    const left = teeSink(a.sink, b.sink);
    const root = teeSink(left, c.sink);
    root.emit(makeEvent("assistant.message", { content: "deep" }));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(c.events).toHaveLength(1);
  });

  it("tee chained with NOOP_SESSION_SINK still delivers to the live sink", () => {
    __resetEventSeq();
    const live = collector();
    const tee = teeSink(NOOP_SESSION_SINK, live.sink, NOOP_SESSION_SINK);
    tee.emit(makeEvent("assistant.message", { content: "v" }));
    expect(live.events).toHaveLength(1);
  });
});
