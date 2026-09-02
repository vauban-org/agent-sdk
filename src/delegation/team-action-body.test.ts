/**
 * team-action-body.test.ts ; the SP-B team-action body protocol (the four
 * team verbs' structured `body` parsers + the fail-closed validator surface).
 * Grounds the "Act on the team" protocol layer (W1) of
 * docs/superpowers/specs/2026-07-14-sp-b-team-action-design.md.
 *
 * The verb->scope table and the ControlVerb enumeration are exercised in
 * control-claim.test.ts ; THIS file exercises the structured-body parsers that
 * turn a control envelope's raw `body` string into a typed team-action request
 * fail-closed. W2 (cli-host) + W3 (pwa) build against this contract.
 */

import { describe, expect, it } from "vitest";
import {
  TEAM_ACTION_VERBS,
  TeamActionBodyError,
  type TeamActionRequest,
  type TeamActionVerb,
  type TeamCoordinateRequest,
  type TeamDelegateRequest,
  type TeamListRequest,
  type TeamSendRequest,
  type TeamStartRequest,
  isTeamActionVerb,
  parseTeamActionBody,
  parseTeamCoordinateBody,
  parseTeamDelegateBody,
  parseTeamListBody,
  parseTeamSendBody,
  parseTeamStartBody,
} from "./teammate-message.js";

describe("team-action verb membership (W1)", () => {
  it("recognizes exactly the five structured-body team-action verbs", () => {
    // SP-C.1 added `start` : it acts on the TEAM (it creates a teammate) and
    // carries a structured body, so it joins this family rather than the
    // opaque-body one.
    expect([...TEAM_ACTION_VERBS].sort()).toEqual(
      ["coordinate", "delegate", "start", "team-list", "team-send"].sort(),
    );
    for (const v of ["team-list", "team-send", "delegate", "coordinate", "start"]) {
      expect(isTeamActionVerb(v)).toBe(true);
    }
  });

  it("rejects a non-team control verb and an unknown string", () => {
    // steer/observe are control verbs but NOT team verbs ; the guard must
    // separate the structured-body verbs from the opaque-body ones.
    expect(isTeamActionVerb("steer")).toBe(false);
    expect(isTeamActionVerb("observe")).toBe(false);
    expect(isTeamActionVerb("message")).toBe(false);
    expect(isTeamActionVerb("selfdestruct")).toBe(false);
  });
});

describe("parseTeamListBody (W1)", () => {
  it("accepts the empty object and an empty/whitespace body (the no-argument read)", () => {
    expect(parseTeamListBody("{}")).toEqual({});
    expect(parseTeamListBody("")).toEqual({});
    expect(parseTeamListBody("   ")).toEqual({});
  });

  it("accepts an optional non-blank filter", () => {
    const req: TeamListRequest = parseTeamListBody('{"filter":"busy"}');
    expect(req).toEqual({ filter: "busy" });
  });

  it("rejects a blank filter, a wrong-typed filter, an extra key, and a non-object", () => {
    expect(() => parseTeamListBody('{"filter":"  "}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamListBody('{"filter":5}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamListBody('{"filter":"ok","rogue":1}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamListBody("[]")).toThrow(TeamActionBodyError);
    expect(() => parseTeamListBody("null")).toThrow(TeamActionBodyError);
    expect(() => parseTeamListBody("not-json")).toThrow(TeamActionBodyError);
  });
});

describe("parseTeamSendBody (W1)", () => {
  it("accepts a well-formed ask and inform", () => {
    const ask: TeamSendRequest = parseTeamSendBody(
      '{"toTarget":"laptop:vera","kind":"ask","body":"run the suite"}',
    );
    expect(ask).toEqual({ toTarget: "laptop:vera", kind: "ask", body: "run the suite" });
    const inform: TeamSendRequest = parseTeamSendBody(
      '{"toTarget":"run-123","kind":"inform","body":"fyi shipped"}',
    );
    expect(inform.kind).toBe("inform");
  });

  it("rejects a missing/blank toTarget, a bad kind, a missing/blank body, extra keys, and non-JSON", () => {
    expect(() => parseTeamSendBody('{"kind":"ask","body":"x"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamSendBody('{"toTarget":"  ","kind":"ask","body":"x"}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamSendBody('{"toTarget":"a","kind":"shout","body":"x"}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamSendBody('{"toTarget":"a","kind":"ask"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamSendBody('{"toTarget":"a","kind":"ask","body":""}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamSendBody('{"toTarget":"a","kind":"ask","body":"x","rogue":1}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamSendBody("nope")).toThrow(TeamActionBodyError);
  });

  it("does not leak the message body content into the error (no raw PII, DECISION 4)", () => {
    // A bad `kind` must be rejected WITHOUT echoing the (opaque, possibly
    // sensitive) message body into the error text.
    const secret = "PATIENT-SSN-123-45-6789";
    try {
      parseTeamSendBody(`{"toTarget":"a","kind":"shout","body":"${secret}"}`);
      throw new Error("expected parseTeamSendBody to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TeamActionBodyError);
      expect((err as TeamActionBodyError).message).not.toContain(secret);
      expect((err as TeamActionBodyError).verb).toBe("team-send");
    }
  });
});

describe("parseTeamDelegateBody (W1)", () => {
  it("accepts a task with no grant and a task with a tools grant", () => {
    const plain: TeamDelegateRequest = parseTeamDelegateBody('{"task":"write the docs"}');
    expect(plain).toEqual({ task: "write the docs" });
    const granted: TeamDelegateRequest = parseTeamDelegateBody(
      '{"task":"ship it","grant":{"tools":["Read","Edit"]}}',
    );
    expect(granted).toEqual({ task: "ship it", grant: { tools: ["Read", "Edit"] } });
  });

  it("accepts an empty grant object (a no-op grant is distinct from absent)", () => {
    expect(parseTeamDelegateBody('{"task":"t","grant":{}}')).toEqual({ task: "t", grant: {} });
  });

  it("rejects a missing/blank task, a non-object grant, a bad tools array, and extra keys", () => {
    expect(() => parseTeamDelegateBody('{"grant":{"tools":["Read"]}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamDelegateBody('{"task":"   "}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamDelegateBody('{"task":"t","grant":"full"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamDelegateBody('{"task":"t","grant":{"tools":"Read"}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamDelegateBody('{"task":"t","grant":{"tools":["Read",""]}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamDelegateBody('{"task":"t","grant":{"rogue":1}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamDelegateBody('{"task":"t","rogue":1}')).toThrow(TeamActionBodyError);
  });

  it("fails closed on a valid task but invalid grant (never returns a partial)", () => {
    // The task is well-formed but the grant is malformed ; the parser must throw
    // rather than silently return { task } and drop the (rejected) grant.
    let returned: TeamDelegateRequest | undefined;
    try {
      returned = parseTeamDelegateBody('{"task":"good task","grant":{"tools":[1,2]}}');
    } catch (err) {
      expect(err).toBeInstanceOf(TeamActionBodyError);
    }
    expect(returned).toBeUndefined();
  });
});

describe("parseTeamCoordinateBody (W1)", () => {
  it("accepts one branch and N branches", () => {
    const one: TeamCoordinateRequest = parseTeamCoordinateBody('{"branches":[{"task":"a"}]}');
    expect(one).toEqual({ branches: [{ task: "a" }] });
    const many = parseTeamCoordinateBody('{"branches":[{"task":"a"},{"task":"b"},{"task":"c"}]}');
    expect(many.branches).toHaveLength(3);
  });

  it("rejects an empty branches array, a missing branches, a blank branch task, a bad branch, and extra keys", () => {
    expect(() => parseTeamCoordinateBody('{"branches":[]}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamCoordinateBody("{}")).toThrow(TeamActionBodyError);
    expect(() => parseTeamCoordinateBody('{"branches":[{"task":"  "}]}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamCoordinateBody('{"branches":[{"task":"a"},null]}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamCoordinateBody('{"branches":[{"task":"a","rogue":1}]}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamCoordinateBody('{"branches":"a"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamCoordinateBody('{"branches":[{"task":"a"}],"rogue":1}')).toThrow(
      TeamActionBodyError,
    );
  });
});

describe("parseTeamActionBody dispatcher (W1)", () => {
  it("routes each verb to its parser (the verb determines the validator)", () => {
    expect(parseTeamActionBody("team-list", "{}")).toEqual({});
    expect(parseTeamActionBody("team-send", '{"toTarget":"a","kind":"ask","body":"x"}')).toEqual({
      toTarget: "a",
      kind: "ask",
      body: "x",
    });
    expect(parseTeamActionBody("delegate", '{"task":"t"}')).toEqual({ task: "t" });
    expect(parseTeamActionBody("coordinate", '{"branches":[{"task":"a"}]}')).toEqual({
      branches: [{ task: "a" }],
    });
  });

  it("propagates the fail-closed throw from the routed parser", () => {
    expect(() => parseTeamActionBody("team-send", "{}")).toThrow(TeamActionBodyError);
    expect(() => parseTeamActionBody("coordinate", '{"branches":[]}')).toThrow(TeamActionBodyError);
  });

  it("rejects a non-team verb passed as a type-lie (runtime fail-closed)", () => {
    // An untyped caller passing a non-team control verb must be rejected, not
    // routed to a benign parser.
    expect(() => parseTeamActionBody("steer" as TeamActionVerb, "{}")).toThrow(TeamActionBodyError);
  });
});

describe("parseTeamStartBody (SP-C.1)", () => {
  it("parses a minimal start body", () => {
    expect(parseTeamStartBody('{"origin":"local","task":"audit the repo"}')).toEqual({
      origin: "local",
      task: "audit the repo",
    });
  });

  it("parses a full start body with name + grant", () => {
    expect(
      parseTeamStartBody(
        '{"origin":"local","task":"t","name":"auditor","grant":{"tools":["read_file"]}}',
      ),
    ).toEqual({ origin: "local", task: "t", name: "auditor", grant: { tools: ["read_file"] } });
  });

  it("accepts every designed origin kind at the PROTOCOL layer", () => {
    // The protocol validates the VOCABULARY ; whether an origin is implemented
    // is the host's decision (an unimplemented kind fails closed at the
    // executor, not here). Keeping the two apart is what lets the pod (SP-C.2)
    // ship without a protocol change.
    for (const origin of ["local", "daemon", "gateway", "pod"]) {
      expect(parseTeamStartBody(`{"origin":"${origin}","task":"t"}`).origin).toBe(origin);
    }
  });

  it("rejects an unknown origin fail-closed", () => {
    expect(() => parseTeamStartBody('{"origin":"k8s","task":"t"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamStartBody('{"origin":"","task":"t"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamStartBody('{"task":"t"}')).toThrow(TeamActionBodyError);
  });

  it("rejects a missing / blank / non-string task fail-closed", () => {
    expect(() => parseTeamStartBody('{"origin":"local"}')).toThrow(TeamActionBodyError);
    expect(() => parseTeamStartBody('{"origin":"local","task":"   "}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamStartBody('{"origin":"local","task":42}')).toThrow(TeamActionBodyError);
  });

  it("rejects a blank name fail-closed", () => {
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","name":"  "}')).toThrow(
      TeamActionBodyError,
    );
  });

  it("rejects a truly unexpected key fail-closed", () => {
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","bogus":"x"}')).toThrow(
      TeamActionBodyError,
    );
  });

  it("accepts an optional repo and surfaces it (opaque <external_data>)", () => {
    expect(parseTeamStartBody('{"origin":"local","task":"t","repo":"vauban-org/preste"}')).toEqual({
      origin: "local",
      task: "t",
      repo: "vauban-org/preste",
    });
  });

  it("rejects a blank or non-string repo fail-closed", () => {
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","repo":"  "}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","repo":7}')).toThrow(
      TeamActionBodyError,
    );
  });

  it("parses a pod-shaped start body with repo (SP-C.2)", () => {
    expect(
      parseTeamStartBody('{"origin":"pod","task":"clone and build","repo":"vauban-org/preste"}'),
    ).toEqual({ origin: "pod", task: "clone and build", repo: "vauban-org/preste" });
  });

  it("rejects a malformed grant rather than dropping it (fail-closed, not partial)", () => {
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","grant":{"tools":"a"}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","grant":{"nope":1}}')).toThrow(
      TeamActionBodyError,
    );
    expect(() => parseTeamStartBody('{"origin":"local","task":"t","grant":[]}')).toThrow(
      TeamActionBodyError,
    );
  });

  it("rejects a non-JSON / non-object body fail-closed", () => {
    expect(() => parseTeamStartBody("not json")).toThrow(TeamActionBodyError);
    expect(() => parseTeamStartBody("[]")).toThrow(TeamActionBodyError);
    expect(() => parseTeamStartBody("")).toThrow(TeamActionBodyError);
  });

  it("never echoes a task VALUE into the error message (spotlighting)", () => {
    const secret = "SECRET-TASK-VALUE";
    try {
      parseTeamStartBody(`{"origin":"nope","task":"${secret}"}`);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TeamActionBodyError);
      expect((err as TeamActionBodyError).message).not.toContain(secret);
    }
  });

  it("routes through the parseTeamActionBody dispatcher", () => {
    expect(parseTeamActionBody("start", '{"origin":"local","task":"t"}')).toEqual({
      origin: "local",
      task: "t",
    });
  });
});

describe("TeamActionBodyError shape (W1)", () => {
  it("carries the verb + a structural reason and a stable name", () => {
    try {
      parseTeamSendBody("{}");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TeamActionBodyError);
      const e = err as TeamActionBodyError;
      expect(e.name).toBe("TeamActionBodyError");
      expect(e.verb).toBe("team-send");
      expect(typeof e.reason).toBe("string");
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});

// Type-level compile check : the union is assignable from each member (keeps the
// exported TeamActionRequest union honest as W2/W3 consume it).
const _typeCheck: TeamActionRequest[] = [
  { filter: "x" } satisfies TeamListRequest,
  { toTarget: "a", kind: "inform", body: "b" } satisfies TeamSendRequest,
  { task: "t" } satisfies TeamDelegateRequest,
  { branches: [{ task: "a" }] } satisfies TeamCoordinateRequest,
  { origin: "local", task: "t" } satisfies TeamStartRequest,
];
void _typeCheck;
