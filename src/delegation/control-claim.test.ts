/**
 * control-claim.test.ts ; the SP1 governed control claim (kind "control" +
 * ControlVerb + the receiver-side scope lens + verifyControlClaim). Grounds
 * the "Governed Controller Principal" L1 (docs/superpowers/specs/
 * 2026-07-11-remote-sessions-sp1-governed-controller-principal-design.md).
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runVerifierBattery } from "../compute/battery/battery.js";
import { createEd25519Signer } from "../remote/signing.js";
import { RecordedClock } from "../replay/clock.js";
import {
  CONTROLLER_CONTROL_ADR,
  CONTROL_VERBS,
  CONTROL_VERB_REQUIRED_SCOPE,
  type ControlScope,
  type ControlVerb,
  RECOGNIZED_CLAIM_KINDS,
  type TeammateEnvelope,
  buildTeammateEnvelopeV2,
  controllerControlScopeLens,
  isControlClaimKind,
  isControlVerb,
  isRecognizedClaimKind,
  requiredScopeForControlVerb,
  verifyControlClaim,
} from "./teammate-message.js";

const { privateKey } = generateKeyPairSync("ed25519");
const sign = createEd25519Signer(privateKey);

describe("control claim vocabulary (Task 1)", () => {
  it("recognizes the control kind fail-closed alongside the existing kinds", () => {
    expect(RECOGNIZED_CLAIM_KINDS.has("control")).toBe(true);
    expect(isRecognizedClaimKind("control")).toBe(true);
    expect(isControlClaimKind("control")).toBe(true);
    expect(isControlClaimKind("ask")).toBe(false);
    expect(isRecognizedClaimKind("mutiny")).toBe(false);
  });

  it("enumerates exactly the sixteen control verbs", () => {
    const verbs: ControlVerb[] = [
      "observe",
      "status",
      "approve",
      "reject",
      "veto",
      "revive",
      "steer",
      "whisper",
      "stop",
      // SP-A W2 (ADR-ECO-126 §A3) ; a REAL user turn, distinct from `steer`
      // (a mid-run instruction). Idle -> a new turn ; running -> the
      // immediately-next turn.
      "message",
      // SP-B (ADR-ECO-126 pillar 3) ; act on the TEAM, not a single session.
      // team-list reads the roster (read-only) ; team-send / delegate /
      // coordinate spawn governed team work (full).
      "team-list",
      "team-send",
      "delegate",
      "coordinate",
      // SP-C.1 (ADR-ECO-126 pillar 4) ; START a session of a given origin,
      // rather than drive one a human already started.
      "start",
      // C3 (session-dans-la-poche) ; request a backlog REPLAY (read-only).
      "sync",
    ];
    expect([...CONTROL_VERBS].sort()).toEqual([...verbs].sort());
    for (const v of verbs) expect(isControlVerb(v)).toBe(true);
    expect(isControlVerb("selfdestruct")).toBe(false);
  });

  it("maps every verb to its required scope (default-deny table is total)", () => {
    expect(Object.keys(CONTROL_VERB_REQUIRED_SCOPE).sort()).toEqual([...CONTROL_VERBS].sort());
    expect(requiredScopeForControlVerb("observe")).toBe("read-only");
    expect(requiredScopeForControlVerb("status")).toBe("read-only");
    expect(requiredScopeForControlVerb("approve")).toBe("approve-only");
    expect(requiredScopeForControlVerb("reject")).toBe("approve-only");
    expect(requiredScopeForControlVerb("veto")).toBe("approve-only");
    expect(requiredScopeForControlVerb("revive")).toBe("approve-only");
    expect(requiredScopeForControlVerb("steer")).toBe("full");
    expect(requiredScopeForControlVerb("whisper")).toBe("full");
    expect(requiredScopeForControlVerb("stop")).toBe("full");
    // `message` starts arbitrary agent work (a real user turn), so it is at
    // least as powerful as `steer` ; same `full` requirement.
    expect(requiredScopeForControlVerb("message")).toBe("full");
    // SP-B team verbs : team-list is a read ; the three that spawn governed
    // team work require `full` (DECISION 2, no new scope tier).
    expect(requiredScopeForControlVerb("team-list")).toBe("read-only");
    expect(requiredScopeForControlVerb("team-send")).toBe("full");
    expect(requiredScopeForControlVerb("delegate")).toBe("full");
    expect(requiredScopeForControlVerb("coordinate")).toBe("full");
    // SP-C.1 : starting a session is strictly higher power than driving one ;
    // `full` is the floor, and the host adds its own opt-in gate on top.
    expect(requiredScopeForControlVerb("start")).toBe("full");
    // C3 (session-dans-la-poche) : a backlog replay is a pure read of already-
    // signed events ; read-only, with observe/status.
    expect(requiredScopeForControlVerb("sync")).toBe("read-only");
  });
});

// Parity fixture: transcribed verbatim from the per-route requireScope(...) gates
// in remote/http-server.ts (and the two gateway callbacks with no http route).
// If a route's scope changes in http-server.ts, update THIS fixture ; that is the
// parity contract (the cost-gate-parity pattern).
const REQUIRE_SCOPE_PARITY: ReadonlyArray<{
  verb: ControlVerb;
  scope: ControlScope;
  portedFrom: string;
}> = [
  { verb: "observe", scope: "read-only", portedFrom: "http-server.ts:530 /remote/stream" },
  { verb: "status", scope: "read-only", portedFrom: "http-server.ts:508 /remote/state" },
  {
    verb: "approve",
    scope: "approve-only",
    portedFrom: "http-server.ts:614 /remote/hitl/:id/approve",
  },
  {
    verb: "reject",
    scope: "approve-only",
    portedFrom: "http-server.ts:614 /remote/hitl/:id/reject",
  },
  { verb: "veto", scope: "approve-only", portedFrom: "http-server.ts:587 /remote/veto/:callId" },
  { verb: "revive", scope: "approve-only", portedFrom: "gateway.ts:190 onRevive (no http route)" },
  { verb: "steer", scope: "full", portedFrom: "http-server.ts:559 /remote/inject" },
  { verb: "whisper", scope: "full", portedFrom: "http-server.ts:559 /remote/inject" },
  { verb: "stop", scope: "full", portedFrom: "gateway.ts:183 onStop (no http route)" },
  // SP-A W2 (ADR-ECO-126 §A3) ; a REAL user turn delivered over the teammate
  // control transport. No http route (like `stop`/`revive`) : the interactive
  // session routes it to the real user-input entry point via the dispatcher's
  // onUserMessage hook (cmd-chat.ts). `full`, same as `steer`.
  {
    verb: "message",
    scope: "full",
    portedFrom: "cmd-chat.ts onUserMessage (no http route ; teammate-transport control verb)",
  },
  // SP-B (ADR-ECO-126 pillar 3) ; team-action verbs delivered over the SAME
  // teammate control transport, wired in W2 (remote-machinery.ts onTeamAction ->
  // roster read / teammate send / delegate() / GovernedWorkflow). No http route
  // (like message/stop/revive) ; the scope source of truth is SP-B DECISION 2,
  // not an http-server route.
  {
    verb: "team-list",
    scope: "read-only",
    portedFrom: "SP-B DECISION 2 ; roster read (no http route ; team verb wired in W2)",
  },
  {
    verb: "team-send",
    scope: "full",
    portedFrom: "SP-B DECISION 2 ; governed teammate send (no http route ; team verb wired in W2)",
  },
  {
    verb: "delegate",
    scope: "full",
    portedFrom: "SP-B DECISION 2 ; governed delegate() (no http route ; team verb wired in W2)",
  },
  {
    verb: "coordinate",
    scope: "full",
    portedFrom:
      "SP-B DECISION 2 ; governed GovernedWorkflow (no http route ; team verb wired in W2)",
  },
  // SP-C.1 (ADR-ECO-126 pillar 4) ; START a session via a SessionOrigin. No
  // http route (like the other team verbs) ; the scope source of truth is the
  // SP-C design note's governance section, not an http-server route. `full` is
  // the FLOOR, not the whole gate : the host also requires the opt-in
  // team-actions flag, and the pod origin (SP-C.2) is T4 on top of that.
  {
    verb: "start",
    scope: "full",
    portedFrom: "SP-C.1 ; governed SessionOrigin.start (no http route ; team verb wired in W2)",
  },
  // C3 (session-dans-la-poche) ; backlog REPLAY request. No http route ; the host
  // re-pushes hub.backlog() (handling wired in a later task). read-only : a pure
  // read of already-signed ring events, source of truth is the C3 design note.
  {
    verb: "sync",
    scope: "read-only",
    portedFrom:
      "C3 ; host re-pushes hub.backlog() (no http route ; handling wired in a later task)",
  },
];

describe("controllerControlScopeLens (Task 2)", () => {
  it("verb-to-scope table is byte-for-byte parity with http-server requireScope", () => {
    expect(REQUIRE_SCOPE_PARITY).toHaveLength([...CONTROL_VERBS].length);
    for (const row of REQUIRE_SCOPE_PARITY) {
      expect(requiredScopeForControlVerb(row.verb)).toBe(row.scope);
    }
  });

  it("is a deterministic rule anchor: covered grant scores 1, uncovered scores 0", async () => {
    const covered = await runVerifierBattery(
      { verb: "steer" },
      [{ verb: "steer", grant: "full", requiredScope: "full", covered: true }],
      [controllerControlScopeLens],
      { runId: "sess-run", adrEco: CONTROLLER_CONTROL_ADR, clock: new RecordedClock([10, 20]) },
    );
    expect(covered.accepted).not.toBeNull();
    expect(covered.auditStep.type).toBe("guard_check");
    expect(covered.auditStep.phase).toBe("guard");
    expect(covered.auditStep.policy).toBe("hash-only");

    const denied = await runVerifierBattery(
      { verb: "steer" },
      [{ verb: "steer", grant: "read-only", requiredScope: "full", covered: false }],
      [controllerControlScopeLens],
      { runId: "sess-run", adrEco: CONTROLLER_CONTROL_ADR, clock: new RecordedClock([10, 20]) },
    );
    expect(denied.accepted).toBeNull(); // fail-closed
  });

  it("replays byte-identical under a fresh RecordedClock seeded with the same timestamps", async () => {
    const candidate = {
      verb: "approve",
      grant: "approve-only" as const,
      requiredScope: "approve-only" as const,
      covered: true,
    };
    const run1 = await runVerifierBattery(
      { verb: "approve" },
      [candidate],
      [controllerControlScopeLens],
      { runId: "sess-run", adrEco: CONTROLLER_CONTROL_ADR, clock: new RecordedClock([10, 20]) },
    );
    const run2 = await runVerifierBattery(
      { verb: "approve" },
      [candidate],
      [controllerControlScopeLens],
      { runId: "sess-run", adrEco: CONTROLLER_CONTROL_ADR, clock: new RecordedClock([10, 20]) },
    );
    expect(run2.auditStep).toEqual(run1.auditStep);
    expect(run2.acceptedHash).toBe(run1.acceptedHash);
  });
});

function controlEnvelope(verb: string, body = ""): TeammateEnvelope {
  return buildTeammateEnvelopeV2(
    {
      id: `ctl-${verb}`,
      fromRunId: "controller-run",
      toRunId: "session-run",
      correlationId: "corr-1",
      fromInstallId: "inst_controller00",
      claim: { kind: "control", capability: verb },
      body,
    },
    { clock: new RecordedClock([1000]), sign },
  );
}

describe("verifyControlClaim (Task 3)", () => {
  it("allows when the grant covers the verb's required scope", async () => {
    const v = await verifyControlClaim(controlEnvelope("steer", "focus on the tests"), "full", {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(true);
    expect(v.verb).toBe("steer");
    expect(v.requiredScope).toBe("full");
    expect(v.auditStep.type).toBe("guard_check");
    // Pin runId = envelope.toRunId (the RECEIVING session's run) ; a
    // fromRunId<->toRunId swap would pass every other assertion here while
    // misfolding this audit step into the controller's own trace instead of
    // the session's (controlEnvelope uses distinct fromRunId/toRunId).
    expect(v.auditStep.runId).toBe("session-run");
  });

  it("denies fail-closed when the grant is below the required scope", async () => {
    const v = await verifyControlClaim(controlEnvelope("steer"), "approve-only", {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("below required");
  });

  it("allows `message` when the grant is full (a real user turn requires full, like steer)", async () => {
    const v = await verifyControlClaim(
      controlEnvelope("message", "run the whole test suite and report"),
      "full",
      { clock: new RecordedClock([1, 2]) },
    );
    expect(v.allowed).toBe(true);
    expect(v.verb).toBe("message");
    expect(v.requiredScope).toBe("full");
    expect(v.auditStep.type).toBe("guard_check");
  });

  it("denies `message` fail-closed for a peer whose grant is below full (ungranted-turn guard)", async () => {
    const v = await verifyControlClaim(controlEnvelope("message", "do the thing"), "approve-only", {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("below required");
  });

  it("denies fail-closed when there is no grant at all (default-deny)", async () => {
    const v = await verifyControlClaim(controlEnvelope("observe"), undefined, {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("no control grant");
  });

  it("allows `sync` for a read-only grant (backlog replay is the least-privileged verb)", async () => {
    // C3 (session-dans-la-poche) : a backlog replay is a pure read, so the
    // lowest grant (read-only) covers it ; and a peer with no grant is denied.
    const ok = await verifyControlClaim(controlEnvelope("sync"), "read-only", {
      clock: new RecordedClock([1, 2]),
    });
    expect(ok.allowed).toBe(true);
    expect(ok.verb).toBe("sync");
    expect(ok.requiredScope).toBe("read-only");

    const denied = await verifyControlClaim(controlEnvelope("sync"), undefined, {
      clock: new RecordedClock([1, 2]),
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("no control grant");
  });

  it("denies fail-closed on an unrecognized verb even with a full grant", async () => {
    const v = await verifyControlClaim(controlEnvelope("selfdestruct"), "full", {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("unrecognized verb");
  });

  it("denies fail-closed on a non-control claim kind even with a covering grant (kind guard)", async () => {
    // A mis-routed `ask` claim carrying a control-verb-shaped string in
    // `capability` must NOT be evaluated as a control claim just because the
    // verb happens to parse ; a `full` grant would cover "steer" if this were
    // a genuine control claim, so allowed:false here proves the kind guard,
    // not the scope check.
    const misRouted = buildTeammateEnvelopeV2(
      {
        id: "ctl-mis-routed",
        fromRunId: "controller-run",
        toRunId: "session-run",
        correlationId: "corr-1",
        fromInstallId: "inst_controller00",
        claim: { kind: "ask", capability: "steer" },
        body: "",
      },
      { clock: new RecordedClock([1000]), sign },
    );
    const v = await verifyControlClaim(misRouted, "full", {
      clock: new RecordedClock([1, 2]),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("not a control claim");
  });

  it("replays byte-identical under RecordedClock (property 4)", async () => {
    const env = controlEnvelope("approve", "hitl-42");
    const a = await verifyControlClaim(env, "approve-only", { clock: new RecordedClock([7, 9]) });
    const b = await verifyControlClaim(env, "approve-only", { clock: new RecordedClock([7, 9]) });
    expect(a.auditStep).toEqual(b.auditStep);
  });
});
