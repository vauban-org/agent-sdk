/**
 * team-action-result-event.test ; sprint-1067 T3 team-actions-v2. The host
 * emits `CUSTOM_TEAM_ACTION_RESULT` on the observe leg for every team action
 * it relays (ask/inform) or executes (team-list/delegate/coordinate/start), so
 * the result is never silently dropped. Anti-oracle: this rides the OBSERVE
 * leg only, never the control ACK (which stays `{steerId, accepted}`).
 */

import { describe, expect, it } from "vitest";
import {
  SessionEventSchema,
  TeamActionResultPayloadSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";

describe("CUSTOM_TEAM_ACTION_RESULT SessionEvent (sprint-1067 T3)", () => {
  it("is a known event type and round-trips through the schema (team-send, delivered)", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_TEAM_ACTION_RESULT", {
      action: "team-send",
      target: "inst_909896241b5bb930#run-abc",
      outcome: "delivered",
    });
    expect(ev.type).toBe("CUSTOM_TEAM_ACTION_RESULT");
    expect(isKnownEventType("CUSTOM_TEAM_ACTION_RESULT")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_TEAM_ACTION_RESULT") {
      expect(parsed.data.data.action).toBe("team-send");
      expect(parsed.data.data.outcome).toBe("delivered");
      expect(parsed.data.data.target).toBe("inst_909896241b5bb930#run-abc");
    }
  });

  it("round-trips a no-route outcome with a structural detail, no roster", () => {
    const ev = makeEvent("CUSTOM_TEAM_ACTION_RESULT", {
      action: "team-send",
      target: "inst_deadbeef#ghost",
      outcome: "no-route",
      detail: "TeammateSendGuidanceError",
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_TEAM_ACTION_RESULT") {
      expect(parsed.data.data.outcome).toBe("no-route");
      expect(parsed.data.data.detail).toBe("TeammateSendGuidanceError");
      expect(parsed.data.data.roster).toBeUndefined();
    }
  });

  it("round-trips a roster row's optional `reachable` flag, and still rejects an unknown key", () => {
    const ev = makeEvent("CUSTOM_TEAM_ACTION_RESULT", {
      action: "team-list",
      outcome: "executed",
      roster: {
        rows: [
          // A live session of another process on this install : visible, but
          // the host says plainly it cannot route to it (sprint-1067 T3).
          {
            address: "inst_self0000000#run-terminal",
            runId: "run-terminal",
            name: "run-terminal",
            reachable: false,
          },
          { address: "inst_self0000000#primary", runId: "run-daemon", name: "primary" },
        ],
        liveSessions: [{ runId: "run-terminal" }, { runId: "run-daemon", name: "primary" }],
      },
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_TEAM_ACTION_RESULT") {
      expect(parsed.data.data.roster?.rows[0]?.reachable).toBe(false);
      // Absent stays absent : a row that never evaluated reachability keeps its
      // pre-T3 shape rather than defaulting to a claim either way.
      expect(parsed.data.data.roster?.rows[1]?.reachable).toBeUndefined();
    }
    const withUnknownKey = TeamActionResultPayloadSchema.safeParse({
      action: "team-list",
      outcome: "executed",
      roster: {
        rows: [{ address: "a", runId: "r", name: "n", routable: true }],
        liveSessions: [],
      },
    });
    expect(withUnknownKey.success).toBe(false);
  });

  it("round-trips a team-list result carrying the roster payload, outcome executed", () => {
    const ev = makeEvent("CUSTOM_TEAM_ACTION_RESULT", {
      action: "team-list",
      outcome: "executed",
      roster: {
        rows: [
          { address: "inst_self0000000#alice", runId: "run-alice", name: "alice" },
          { address: "bob:api", runId: "run-bob", name: "api", peerLabel: "bob" },
        ],
        liveSessions: [{ runId: "run-alice", name: "alice" }, { runId: "run-headless" }],
      },
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_TEAM_ACTION_RESULT") {
      expect(parsed.data.data.roster?.rows).toHaveLength(2);
      expect(parsed.data.data.roster?.rows[0]?.address).toBe("inst_self0000000#alice");
      expect(parsed.data.data.roster?.liveSessions).toHaveLength(2);
      expect(parsed.data.data.roster?.liveSessions[1]?.name).toBeUndefined();
    }
  });

  it("the payload schema rejects an unknown outcome value (fail-closed transport shape)", () => {
    const bad = TeamActionResultPayloadSchema.safeParse({
      action: "team-send",
      outcome: "maybe",
    });
    expect(bad.success).toBe(false);
  });

  it("the payload schema rejects an unknown extra field (.strict, no smuggled task/body value)", () => {
    const bad = TeamActionResultPayloadSchema.safeParse({
      action: "delegate",
      outcome: "executed",
      task: "TOP-SECRET-TASK-VALUE", // .strict() must reject ; SP-B DECISION 4
    });
    expect(bad.success).toBe(false);
  });

  it("the payload schema rejects an unknown action verb", () => {
    const bad = TeamActionResultPayloadSchema.safeParse({
      action: "team-broadcast",
      outcome: "executed",
    });
    expect(bad.success).toBe(false);
  });
});
