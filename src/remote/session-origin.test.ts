/**
 * session-origin.test.ts ; SP-C.1 (ADR-ECO-126 pillar 4) ; the SessionOrigin
 * port's protocol-level contract. Pure : no substrate, no network, no LLM.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_SESSION_ORIGIN_KINDS,
  SessionOriginError,
  isSessionOriginKind,
} from "./session-origin.js";
import type { SessionOrigin, SessionStartRequest, StartedSession } from "./session-origin.js";

describe("SessionOriginKind", () => {
  it("names exactly the four designed origins", () => {
    expect([...ALL_SESSION_ORIGIN_KINDS]).toEqual(["local", "daemon", "gateway", "pod"]);
  });

  it("narrows a known kind and rejects an unknown one fail-closed", () => {
    expect(isSessionOriginKind("local")).toBe(true);
    expect(isSessionOriginKind("pod")).toBe(true);
    expect(isSessionOriginKind("k8s")).toBe(false);
    expect(isSessionOriginKind("")).toBe(false);
    expect(isSessionOriginKind("LOCAL")).toBe(false);
  });
});

describe("SessionOriginError", () => {
  it("carries a structural reason and never the task VALUE", () => {
    const err = new SessionOriginError("local", "substrate-unavailable");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionOriginError");
    expect(err.kind).toBe("local");
    expect(err.reason).toBe("substrate-unavailable");
    expect(err.message).toBe("SessionOriginError [local]: substrate-unavailable");
  });
});

describe("SessionOrigin (structural contract)", () => {
  // A minimal in-memory origin proves the port is implementable against any
  // substrate ; the real LocalSessionOrigin lives in the CLI (the SDK must
  // never import preste).
  function fakeOrigin(): SessionOrigin {
    const started = new Map<string, StartedSession>();
    return {
      kind: "local",
      async start(req: SessionStartRequest): Promise<StartedSession> {
        const session: StartedSession = {
          runId: `run-${started.size + 1}`,
          kind: "local",
          announced: true,
          toolsEnforced: false,
          ...(req.work.name !== undefined ? { name: req.work.name } : {}),
        };
        started.set(session.runId, session);
        return session;
      },
      async attach(ref) {
        const found = started.get(ref.runId);
        if (found === undefined) throw new SessionOriginError("local", "session-not-found");
        return { runId: found.runId, kind: "local", announced: true };
      },
    };
  }

  it("start() produces an announced, identified session", async () => {
    const origin = fakeOrigin();
    const session = await origin.start({
      kind: "local",
      work: { task: "audit the repo", name: "auditor" },
      grant: { by: "controller:abc" },
    });
    expect(session.runId).toBe("run-1");
    expect(session.kind).toBe("local");
    expect(session.announced).toBe(true);
    expect(session.name).toBe("auditor");
  });

  it("attach() resolves a started session and fails closed on an unknown ref", async () => {
    const origin = fakeOrigin();
    const started = await origin.start({
      kind: "local",
      work: { task: "t" },
      grant: { by: "controller:abc" },
    });
    await expect(origin.attach({ runId: started.runId })).resolves.toMatchObject({
      runId: started.runId,
      kind: "local",
    });
    await expect(origin.attach({ runId: "nope" })).rejects.toThrow(SessionOriginError);
  });
});
