/**
 * Tests for `RemoteControlPort.observerSink()` — the seam that lets a
 * delegated child's interior reach the controller's observe transcript
 * WITHOUT overwriting the parent session's derived state.
 *
 * Why the seam exists rather than a runId filter inside the hub: the
 * `SessionEvent` envelope carries no `runId`. Only RUN_STARTED / RUN_FINISHED
 * name one (in `data`); STEP_STARTED, TOOL_CALL_START, TEXT_MESSAGE_CONTENT
 * and friends carry none at all — so the hub cannot tell a child's event from
 * its own by inspection. The caller that spawns the child (SP-B's
 * `delegate` / `coordinate`, per ADR-ECO-076 / ADR-ECO-083) is the only place
 * that knows, so it picks the sink.
 *
 * The bug this pins: with the child teed onto `hub.emit`, the child's
 * RUN_STARTED flipped `state().runId` to the child's and its RUN_FINISHED
 * reported the still-live session as `"finished"` / `"stopped"`.
 */

import { describe, expect, it } from "vitest";
import {
  type SessionEvent,
  __resetEventSeq,
  createRemoteControlHub,
  makeEvent,
} from "../../src/remote/index.js";

const startedAt = new Date().toISOString();

function runStart(runId: string, agentId: string): SessionEvent {
  return makeEvent("run.start", { runId, agentId, startedAt });
}

function runFinish(runId: string, stepCount: number, costUsd: number): SessionEvent {
  return makeEvent("run.finished", {
    runId,
    stopReason: "complete",
    stepCount,
    costUsd,
    finishedAt: new Date().toISOString(),
  });
}

describe("observerSink — displays without folding into SessionState", () => {
  it("a child's RUN_STARTED does not steal the session's runId", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(runStart("session-run", "PARENT"));

    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));

    expect(hub.state().runId).toBe("session-run");
    expect(hub.state().agentId).toBe("PARENT");
  });

  it("a child's RUN_FINISHED does not report the live session as finished", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(runStart("session-run", "PARENT"));

    // The whole child lifecycle — the exact sequence spawnChildAgent tees.
    const observer = hub.observerSink();
    observer.emit(runStart("child-run", "CHILD_AGENT"));
    observer.emit(
      makeEvent("tool.call.start", { callId: "c1", toolName: "read_file", argsPreview: "{}" }),
    );
    observer.emit(
      makeEvent("tool.call.end", {
        callId: "c1",
        toolName: "read_file",
        ok: true,
        resultPreview: "…",
      }),
    );
    observer.emit(runFinish("child-run", 2, 0.02));

    // The session is still running — only the CHILD finished.
    expect(hub.state().status).toBe("running");
    expect(hub.state().phase).not.toBe("stopped");
    expect(hub.state().runId).toBe("session-run");
  });

  it("the session's own events still fold normally after a child ran", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(runStart("session-run", "PARENT"));
    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));
    hub.observerSink().emit(runFinish("child-run", 2, 0.02));

    hub.emit(runFinish("session-run", 7, 0.5));

    expect(hub.state().status).toBe("finished");
    expect(hub.state().stepCount).toBe(7);
    expect(hub.state().runId).toBe("session-run");
  });

  it("a child's step telemetry does not corrupt the session's step/cost counters", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(runStart("session-run", "PARENT"));
    hub.emit(makeEvent("run.step", { stepIndex: 0, inputTokens: 10, outputTokens: 5, costUsd: 1 }));

    hub
      .observerSink()
      .emit(
        makeEvent("run.step", { stepIndex: 41, inputTokens: 99, outputTokens: 99, costUsd: 99 }),
      );

    expect(hub.state().stepCount).toBe(1);
    expect(hub.state().costUsd).toBe(1);
  });
});

describe("observerSink — the child still reaches the transcript", () => {
  it("fans a child's events out to live subscribers (the observe transcript)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const seen: SessionEvent[] = [];
    hub.subscribe((e) => seen.push(e));

    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));
    hub
      .observerSink()
      .emit(
        makeEvent("tool.call.start", { callId: "c1", toolName: "read_file", argsPreview: "{}" }),
      );

    expect(seen.map((e) => e.type)).toEqual(["RUN_STARTED", "TOOL_CALL_START"]);
  });

  it("buffers a child's events so a reconnecting controller backfills them", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(runStart("session-run", "PARENT"));
    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));

    expect(hub.backlog().map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_STARTED"]);
  });

  it("normalises legacy dotted types exactly like emit", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const seen: SessionEvent[] = [];
    hub.subscribe((e) => seen.push(e));

    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));

    expect(seen[0].type).toBe("RUN_STARTED");
  });

  it("signs a child's events exactly like emit (tamper-evident transcript)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ signFn: () => "sig-stub" });

    hub.observerSink().emit(runStart("child-run", "CHILD_AGENT"));

    expect(hub.backlog()[0].sig).toBe("sig-stub");
  });

  it("returns a stable instance (safe to hold, tee, or compare by identity)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    expect(hub.observerSink()).toBe(hub.observerSink());
  });
});
