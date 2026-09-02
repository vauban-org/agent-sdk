/**
 * auto-verdict-event.test ; sprint-1067 t3 auto-approve-visibility. A request
 * resolved WITHOUT asking anyone (a matched standing grant, or a replayed
 * recent verdict for the same tool + scope + content) is announced on the
 * observe leg as `CUSTOM_AUTO_VERDICT`, so a phone never watches an action land
 * with no card and no explanation.
 *
 * Anti-oracle: observe leg only, never the control ACK (which stays
 * `{steerId, accepted}`). Strict schema: the payload carries the TOOL and the
 * SCOPE that matched, never the request's arguments or content.
 */

import { describe, expect, it } from "vitest";
import {
  AutoVerdictPayloadSchema,
  SessionEventSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";

describe("CUSTOM_AUTO_VERDICT SessionEvent (sprint-1067 t3)", () => {
  it("is a known event type and round-trips a grant hit", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_AUTO_VERDICT", {
      reason: "grant",
      tool: "write_file",
      pattern: "/tmp/**",
      scope: "session",
      approved: true,
    });
    expect(ev.type).toBe("CUSTOM_AUTO_VERDICT");
    expect(isKnownEventType("CUSTOM_AUTO_VERDICT")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_AUTO_VERDICT") {
      expect(parsed.data.data.reason).toBe("grant");
      expect(parsed.data.data.scope).toBe("session");
      expect(parsed.data.data.approved).toBe(true);
    }
  });

  it("carries a REFUSED replay ; a coalesced verdict is not always an approval", () => {
    const ev = makeEvent("CUSTOM_AUTO_VERDICT", {
      reason: "coalesced",
      tool: "run_bash",
      pattern: "git push",
      approved: false,
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_AUTO_VERDICT") {
      expect(parsed.data.data.approved).toBe(false);
      expect(parsed.data.data.scope).toBeUndefined();
    }
  });

  it("accepts a replay with no derivable pattern ; the fact still gets announced", () => {
    const ok = AutoVerdictPayloadSchema.safeParse({
      reason: "coalesced",
      tool: "fetch_url",
      approved: true,
    });
    expect(ok.success).toBe(true);
  });

  it("requires the reason ; « resolved without asking » is meaningless without why", () => {
    const bad = AutoVerdictPayloadSchema.safeParse({
      tool: "write_file",
      approved: true,
    });
    expect(bad.success).toBe(false);
  });

  it("refuses an unknown reason rather than carrying it through", () => {
    const bad = AutoVerdictPayloadSchema.safeParse({
      reason: "vibes",
      tool: "write_file",
      approved: true,
    });
    expect(bad.success).toBe(false);
  });

  it("is strict ; the request's own arguments cannot be smuggled in", () => {
    const bad = AutoVerdictPayloadSchema.safeParse({
      reason: "grant",
      tool: "write_file",
      pattern: "/tmp/**",
      scope: "always",
      approved: true,
      context: '{"path":"/tmp/secret","content":"…"}',
    });
    expect(bad.success).toBe(false);
  });
});
