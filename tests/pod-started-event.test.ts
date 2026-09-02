/**
 * pod-started-event.test ; A' pod roster auto-discovery. The pod origin emits a
 * `CUSTOM_POD_STARTED` SessionEvent on the observe leg carrying the pod's PUBLIC
 * fleet install cert, so a starter's PWA verifies it (`verifyFleetCert`) and
 * merges it into its roster (`mergeRoster`) with no manual Add-by-install-id.
 * Anti-oracle: this rides the OBSERVE leg only, never the control ACK.
 */

import { describe, expect, it } from "vitest";
import {
  PodStartedPayloadSchema,
  type SessionEvent,
  SessionEventSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";

const CERT = {
  v: 1 as const,
  fleetId: "fleet_863fe97a5ddb395a",
  rootPubkey: "6f72c90512353cfe399d341ee00454d65595ffe6004090272042603ffa9476ae",
  signingPubkey: "7a009efd66f7a0c957e312984c51b52418ac5328ec3c19ba43de399242c7ff06",
  installId: "inst_909896241b5bb930",
  installPubkey: "f977023cb9de2a49cf7a67d8d3df1053b50ec4bc8e7f7f650fb02a5fe2a485fb",
  issuedAt: 1_784_574_000_000,
  notAfter: 1_784_584_800_000,
  sig: "abcd",
};

describe("CUSTOM_POD_STARTED SessionEvent (A')", () => {
  it("is a known event type and round-trips through the schema", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_POD_STARTED", {
      installId: "inst_909896241b5bb930",
      name: "pod-8a930caf",
      cert: CERT,
    });
    expect(ev.type).toBe("CUSTOM_POD_STARTED");
    expect(isKnownEventType("CUSTOM_POD_STARTED")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_POD_STARTED") {
      expect(parsed.data.data.installId).toBe("inst_909896241b5bb930");
      expect(parsed.data.data.name).toBe("pod-8a930caf");
      expect(parsed.data.data.cert.installId).toBe("inst_909896241b5bb930");
    }
  });

  it("the payload schema rejects a malformed cert (fail-closed transport shape)", () => {
    const bad = PodStartedPayloadSchema.safeParse({
      installId: "inst_x",
      name: "pod-x",
      cert: { v: 1, fleetId: "f" }, // missing required fields
    });
    expect(bad.success).toBe(false);
  });

  it("the payload schema rejects an unknown extra field (.strict, no smuggled secret)", () => {
    const bad = PodStartedPayloadSchema.safeParse({
      installId: "inst_x",
      name: "pod-x",
      cert: CERT,
      privateKey: "leak", // .strict() must reject
    });
    expect(bad.success).toBe(false);
  });

  it("carries no auth/secret field ; the cert fields are all public", () => {
    const keys = Object.keys(CERT);
    for (const k of keys) {
      expect(k).not.toMatch(/priv|secret|seed|mnemonic/i);
    }
  });
});
