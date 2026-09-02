/**
 * remote-grant-event.test ; sprint-1067 t3 remote-grant-scopes. A standing
 * grant minted from a REMOTE approval is announced on the observe leg as
 * `CUSTOM_REMOTE_GRANT`, so a grant never appears in the session's memory
 * without a visible trace of who created it. Anti-oracle: this rides the
 * OBSERVE leg only, never the control ACK (which stays `{steerId, accepted}`).
 */

import { describe, expect, it } from "vitest";
import {
  RemoteGrantPayloadSchema,
  SessionEventSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";

describe("CUSTOM_REMOTE_GRANT SessionEvent (sprint-1067 t3)", () => {
  it("is a known event type and round-trips a session grant", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_REMOTE_GRANT", {
      scope: "session",
      tool: "write_file",
      pattern: "/home/f/notes/**",
      by: "controller:inst_909896241b5bb930",
    });
    expect(ev.type).toBe("CUSTOM_REMOTE_GRANT");
    expect(isKnownEventType("CUSTOM_REMOTE_GRANT")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_REMOTE_GRANT") {
      expect(parsed.data.data.scope).toBe("session");
      expect(parsed.data.data.tool).toBe("write_file");
      expect(parsed.data.data.requestedScope).toBeUndefined();
    }
  });

  it("carries BOTH halves of a downgrade (asked always, got session)", () => {
    const ev = makeEvent("CUSTOM_REMOTE_GRANT", {
      scope: "session",
      tool: "run_bash",
      pattern: "git push",
      by: "controller:inst_909896241b5bb930",
      requestedScope: "always",
      downgradeReason: "ceremony",
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_REMOTE_GRANT") {
      expect(parsed.data.data.scope).toBe("session");
      expect(parsed.data.data.requestedScope).toBe("always");
      expect(parsed.data.data.downgradeReason).toBe("ceremony");
    }
  });

  it("rejects `once` ; nothing was minted, so there is nothing to announce", () => {
    const bad = RemoteGrantPayloadSchema.safeParse({
      scope: "once",
      tool: "write_file",
      pattern: "/tmp/**",
      by: "controller:inst_x",
    });
    expect(bad.success).toBe(false);
  });

  it("is strict ; an unknown field is rejected rather than carried", () => {
    const bad = RemoteGrantPayloadSchema.safeParse({
      scope: "always",
      tool: "write_file",
      pattern: "/tmp/**",
      by: "controller:inst_x",
      context: '{"path":"/tmp/secret"}',
    });
    expect(bad.success).toBe(false);
  });
});
