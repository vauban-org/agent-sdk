/**
 * Schema-level tests for CUSTOM_TEAMMATE_DELIVERY (sprint-893 d1, ZD4).
 *
 * Proves the new event type is structurally DISTINCT from
 * CUSTOM_INSTRUCTION_INJECTED (the type an operator's own `/remote/inject`
 * produces) even though both can describe "a message reached the running
 * session" ; a consumer can tell them apart by `type` alone, never by
 * string-sniffing `data.source`.
 */

import { describe, expect, it } from "vitest";
import {
  SessionEventSchema,
  __resetEventSeq,
  looksLikeSessionEvent,
  makeEvent,
} from "../../src/remote/events.js";

describe("CUSTOM_TEAMMATE_DELIVERY ; schema shape", () => {
  it("parses a teammate-origin delivery with cross-install origin + capability", () => {
    __resetEventSeq();
    const event = makeEvent("CUSTOM_TEAMMATE_DELIVERY", {
      envelopeId: "env-1",
      claimKind: "ask",
      fromRunId: "peer-run-abc",
      fromInstallId: "inst-peer",
      capability: "deploy",
    });
    const parsed = SessionEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    expect(looksLikeSessionEvent(event)).toBe(true);
  });

  it("parses a same-install inform delivery with no installId/capability (both optional)", () => {
    __resetEventSeq();
    const event = makeEvent("CUSTOM_TEAMMATE_DELIVERY", {
      envelopeId: "env-2",
      claimKind: "inform",
      fromRunId: "local-run",
    });
    const parsed = SessionEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown claimKind (closed enum, not a free-text string)", () => {
    __resetEventSeq();
    const bad = {
      type: "CUSTOM_TEAMMATE_DELIVERY",
      id: "evt_x",
      seq: 0,
      ts: new Date().toISOString(),
      data: { envelopeId: "e", claimKind: "broadcast", fromRunId: "r" },
    };
    expect(SessionEventSchema.safeParse(bad).success).toBe(false);
  });

  it("is structurally distinct from CUSTOM_INSTRUCTION_INJECTED ; no shared required fields", () => {
    __resetEventSeq();
    const teammateEvent = makeEvent("CUSTOM_TEAMMATE_DELIVERY", {
      envelopeId: "env-3",
      claimKind: "inform",
      fromRunId: "peer-run",
    });
    const operatorEvent = makeEvent("CUSTOM_INSTRUCTION_INJECTED", {
      text: "do the thing",
      source: "remote:phone",
      whisper: false,
    });
    expect(teammateEvent.type).not.toBe(operatorEvent.type);
    expect(SessionEventSchema.safeParse(teammateEvent).success).toBe(true);
    expect(SessionEventSchema.safeParse(operatorEvent).success).toBe(true);
    // A consumer discriminates on `type` alone ; never on a `source` string
    // prefix, which is all CUSTOM_INSTRUCTION_INJECTED itself ever carried.
    expect("source" in teammateEvent.data).toBe(false);
    expect("fromRunId" in operatorEvent.data).toBe(false);
  });
});
