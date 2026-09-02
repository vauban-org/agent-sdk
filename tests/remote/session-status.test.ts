/**
 * Tests for the SessionStatus / LinkStatus vocabulary (SP2-B) — the richer
 * status surface a multi-session controller dashboard (SP2-D) needs, layered
 * on top of `RemoteControlHub`'s existing 3-value `SessionState.status`
 * lifecycle, plus a `backlogOldestSeq()` accessor so a reconnecting
 * controller can detect a truncated backlog.
 *
 * `SessionState.phase` is grounded in the REAL SessionEvent types
 * minimal-loop.ts and approval.ts already emit — not an invented vocabulary:
 *   - RUN_STARTED / TOOL_CALL_END / CUSTOM_HITL_RESOLVED → "thinking"
 *     (the loop is about to, or has just returned to, the blocking
 *     `provider.complete()` round-trip ; minimal-loop.ts:666).
 *   - TOOL_CALL_START..TOOL_CALL_END → "tool-call" (`tools.execute()` await,
 *     minimal-loop.ts:949).
 *   - CUSTOM_TOOL_INTENT..{TOOL_CALL_END|TOOL_CALL_START} → "blocked" (T6a
 *     veto window, `vetoChannel.await()`, minimal-loop.ts:917).
 *   - CUSTOM_HITL_REQUEST..CUSTOM_HITL_RESOLVED → "awaiting-hitl"
 *     (`approval.ts`'s dangerous-tool gate, awaited from
 *     minimal-loop.ts's `awaitApproval`).
 *   - RUN_FINISHED → "stopped" (terminal, any stopReason).
 * STEP_STARTED deliberately leaves `phase` unchanged (see the boundary test
 * below) — it is retroactive step telemetry emitted synchronously before the
 * event that actually clarifies what happens next.
 *
 * `LinkStatus` is NOT derived by the hub — it describes a remote
 * controller's own transport-link health, which the session side cannot
 * observe. It ships as a validated wire vocabulary only.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_LINK_STATUSES,
  __resetEventSeq,
  createRemoteControlHub,
  isLinkStatus,
  makeEvent,
} from "../../src/remote/index.js";

describe("SessionState.phase — grounded in real loop-emitted SessionEvents", () => {
  it("starts idle before any event", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    expect(hub.state().phase).toBe("idle");
  });

  it("RUN_STARTED moves phase to thinking (about to await the LLM round-trip)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    expect(hub.state().phase).toBe("thinking");
  });

  it("STEP_STARTED leaves phase unchanged (retroactive telemetry, not a transition)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    expect(hub.state().phase).toBe("thinking");
    hub.emit(
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      }),
    );
    expect(hub.state().phase).toBe("thinking");
  });

  it("CUSTOM_TOOL_INTENT moves phase to blocked (T6a veto window)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("tool.intent", {
        callId: "c1",
        toolName: "run_bash",
        argsPreview: "{}",
        vetoWindowMs: 3000,
      }),
    );
    expect(hub.state().phase).toBe("blocked");
  });

  it("a vetoed call resolves blocked -> thinking via TOOL_CALL_END(ok:false)", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("tool.intent", {
        callId: "c1",
        toolName: "run_bash",
        argsPreview: "{}",
        vetoWindowMs: 3000,
      }),
    );
    expect(hub.state().phase).toBe("blocked");
    hub.emit(
      makeEvent("tool.call.end", {
        callId: "c1",
        toolName: "run_bash",
        ok: false,
        resultPreview: "[vetoed by operator]",
      }),
    );
    expect(hub.state().phase).toBe("thinking");
  });

  it("TOOL_CALL_START moves phase to tool-call, TOOL_CALL_END returns it to thinking", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("tool.call.start", {
        callId: "c2",
        toolName: "read_file",
        argsPreview: "{}",
      }),
    );
    expect(hub.state().phase).toBe("tool-call");
    hub.emit(
      makeEvent("tool.call.end", {
        callId: "c2",
        toolName: "read_file",
        ok: true,
        resultPreview: "contents",
      }),
    );
    expect(hub.state().phase).toBe("thinking");
  });

  it("CUSTOM_HITL_REQUEST moves phase to awaiting-hitl, CUSTOM_HITL_RESOLVED returns it to thinking", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("hitl.request", {
        requestId: "h1",
        action: "anchor_seal",
        context: "{}",
      }),
    );
    expect(hub.state().phase).toBe("awaiting-hitl");
    hub.emit(
      makeEvent("hitl.resolved", {
        requestId: "h1",
        approved: true,
        by: "operator",
      }),
    );
    expect(hub.state().phase).toBe("thinking");
  });

  it("RUN_FINISHED moves phase to stopped regardless of stopReason", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    hub.emit(
      makeEvent("run.finished", {
        runId: "r1",
        stopReason: "budget_exhausted",
        stepCount: 3,
        costUsd: 0.5,
        finishedAt: new Date().toISOString(),
      }),
    );
    expect(hub.state().phase).toBe("stopped");
  });

  it("folds a full tool-calling run through the expected phase sequence", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const seen: string[] = [];
    const record = (): void => {
      seen.push(hub.state().phase);
    };

    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    record(); // thinking
    hub.emit(makeEvent("run.step", { stepIndex: 0, inputTokens: 1, outputTokens: 1, costUsd: 0 }));
    record(); // thinking (unchanged)
    hub.emit(makeEvent("tool.call.start", { callId: "c1", toolName: "x", argsPreview: "{}" }));
    record(); // tool-call
    hub.emit(
      makeEvent("tool.call.end", {
        callId: "c1",
        toolName: "x",
        ok: true,
        resultPreview: "ok",
      }),
    );
    record(); // thinking
    hub.emit(
      makeEvent("run.finished", {
        runId: "r1",
        stopReason: "complete",
        stepCount: 1,
        costUsd: 0,
        finishedAt: new Date().toISOString(),
      }),
    );
    record(); // stopped

    expect(seen).toEqual(["thinking", "thinking", "tool-call", "thinking", "stopped"]);
  });
});

describe("LinkStatus — validated wire vocabulary for a reconnecting controller", () => {
  it("accepts every real LinkStatus value", () => {
    for (const v of ALL_LINK_STATUSES) {
      expect(isLinkStatus(v)).toBe(true);
    }
  });

  it("rejects an arbitrary or malformed string", () => {
    expect(isLinkStatus("disconnected")).toBe(false);
    expect(isLinkStatus("")).toBe(false);
    expect(isLinkStatus("CONNECTED")).toBe(false);
  });

  it("exposes exactly the three grounded values, no more no less", () => {
    expect([...ALL_LINK_STATUSES].sort()).toEqual(
      ["connected", "reconnecting", "relay-unreachable"].sort(),
    );
  });
});

describe("RemoteControlHub — backlogOldestSeq (gap detection for reconnecting controllers)", () => {
  it("is null on an empty buffer", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    expect(hub.backlogOldestSeq()).toBeNull();
  });

  it("reflects the oldest retained event's seq, no eviction yet", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const e0 = makeEvent("assistant.message", { content: "0" });
    hub.emit(e0);
    hub.emit(makeEvent("assistant.message", { content: "1" }));
    expect(hub.backlogOldestSeq()).toBe(e0.seq);
  });

  it("advances past an evicted event once bufferSize is exceeded", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 2 });
    const e0 = makeEvent("assistant.message", { content: "0" });
    const e1 = makeEvent("assistant.message", { content: "1" });
    hub.emit(e0);
    hub.emit(e1);
    expect(hub.backlogOldestSeq()).toBe(e0.seq);
    hub.emit(makeEvent("assistant.message", { content: "2" })); // evicts e0
    expect(hub.backlogOldestSeq()).toBe(e1.seq);
  });

  it("lets a caller detect that a reconnecting cursor fell outside the buffer", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 2 });
    const e0 = makeEvent("assistant.message", { content: "0" });
    hub.emit(e0);
    hub.emit(makeEvent("assistant.message", { content: "1" }));
    hub.emit(makeEvent("assistant.message", { content: "2" })); // evicts e0

    // A controller that last saw e0.seq reconnects with sinceSeq = e0.seq.
    // Its cursor no longer covers the oldest retained event -> truncated.
    const oldest = hub.backlogOldestSeq();
    expect(oldest).not.toBeNull();
    expect(oldest! > e0.seq + 1).toBe(false); // exactly one gap-free step ahead here...
    // ...but the point of the accessor is this comparison, which the caller
    // (SP2-C) makes: sinceSeq < oldestSeq - 1 means events were dropped.
    const sinceSeq = e0.seq; // the controller's last-seen cursor
    const truncated = oldest !== null && sinceSeq < oldest - 1;
    // Only 1 event (e0) was evicted here, so sinceSeq (e0.seq) sits exactly
    // oldest-2 -> still a genuine gap versus what the controller expects
    // (it expects backlog(sinceSeq) to start at sinceSeq+1 = e0.seq+1, but
    // the buffer's floor is e1.seq = e0.seq+1, so THIS case is gap-free).
    expect(truncated).toBe(false);

    // Force a real gap: evict a second event so two are missing.
    hub.emit(makeEvent("assistant.message", { content: "3" })); // evicts e1
    const oldest2 = hub.backlogOldestSeq();
    const truncated2 = oldest2 !== null && sinceSeq < oldest2 - 1;
    expect(truncated2).toBe(true);
  });

  it("backlog() and backlogOldestSeq() agree without requiring a full copy", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub({ bufferSize: 5 });
    for (let i = 0; i < 10; i++) {
      hub.emit(makeEvent("assistant.message", { content: String(i) }));
    }
    const full = hub.backlog();
    expect(hub.backlogOldestSeq()).toBe(full[0].seq);
  });
});
