/**
 * cert-renewed-event.test ; finding #5b, fleet-cert renewal delivery. The fleet
 * host emits a `CUSTOM_FLEET_CERT_RENEWED` SessionEvent on the observe leg
 * carrying a member's freshly-renewed PUBLIC fleet install cert, so a browser
 * member (already watching the fleet-CEK-encrypted observe leg) verifies it
 * (`verifyFleetCert`) and folds the extended validity window into its stored
 * cert with no re-key ceremony. Sibling of A' (CUSTOM_POD_STARTED) : same
 * structural cert, same observe-leg-only, same anti-oracle discipline (a
 * renewal never rides any ack ; every field is public).
 */

import { describe, expect, it } from "vitest";
import {
  CertRenewedPayloadSchema,
  FleetSigningKeyCertSchema,
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

/** The root-signed signing-key cert shape (no installId/installPubkey/name ;
 * a smaller object than the install cert). Rides the renewal rail on rotation. */
const SIGNING_KEY_CERT = {
  v: 1 as const,
  fleetId: "fleet_863fe97a5ddb395a",
  rootPubkey: "6f72c90512353cfe399d341ee00454d65595ffe6004090272042603ffa9476ae",
  signingPubkey: "7a009efd66f7a0c957e312984c51b52418ac5328ec3c19ba43de399242c7ff06",
  issuedAt: 1_784_574_000_000,
  notAfter: 1_787_166_000_000,
  sig: "ef01",
};

describe("CUSTOM_FLEET_CERT_RENEWED SessionEvent (finding #5b)", () => {
  it("is a known event type and round-trips through the schema", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_FLEET_CERT_RENEWED", {
      installId: "inst_909896241b5bb930",
      cert: CERT,
    });
    expect(ev.type).toBe("CUSTOM_FLEET_CERT_RENEWED");
    expect(isKnownEventType("CUSTOM_FLEET_CERT_RENEWED")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_FLEET_CERT_RENEWED") {
      expect(parsed.data.data.installId).toBe("inst_909896241b5bb930");
      expect(parsed.data.data.cert.installId).toBe("inst_909896241b5bb930");
    }
  });

  it("the payload schema rejects a malformed cert (fail-closed transport shape)", () => {
    const bad = CertRenewedPayloadSchema.safeParse({
      installId: "inst_x",
      cert: { v: 1, fleetId: "f" }, // missing required fields
    });
    expect(bad.success).toBe(false);
  });

  it("the payload schema rejects an unknown extra field (.strict, no smuggled secret)", () => {
    for (const smuggle of [{ installKey: "leak" }, { privHex: "leak" }, { cek: "leak" }]) {
      const bad = CertRenewedPayloadSchema.safeParse({
        installId: "inst_x",
        cert: CERT,
        ...smuggle, // .strict() must reject any field beyond installId + cert
      });
      expect(bad.success).toBe(false);
    }
  });

  it("the cert schema itself rejects a smuggled secret field (.strict)", () => {
    const bad = CertRenewedPayloadSchema.safeParse({
      installId: "inst_909896241b5bb930",
      cert: { ...CERT, privateKey: "leak" }, // the nested cert is .strict() too
    });
    expect(bad.success).toBe(false);
  });

  it("carries no auth/secret field ; the cert fields are all public", () => {
    for (const k of Object.keys(CERT)) {
      expect(k).not.toMatch(/priv|secret|seed|mnemonic/i);
    }
  });

  it("accepts an OPTIONAL signingKeyCert (rotation rail) and round-trips it", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_FLEET_CERT_RENEWED", {
      installId: "inst_909896241b5bb930",
      cert: CERT,
      signingKeyCert: SIGNING_KEY_CERT,
    });
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_FLEET_CERT_RENEWED") {
      expect(parsed.data.data.signingKeyCert?.signingPubkey).toBe(SIGNING_KEY_CERT.signingPubkey);
    }
  });

  it("is byte-identical to today WITHOUT signingKeyCert (backward compatible)", () => {
    const withoutField = CertRenewedPayloadSchema.safeParse({
      installId: "inst_909896241b5bb930",
      cert: CERT,
    });
    expect(withoutField.success).toBe(true);
    if (withoutField.success) {
      expect(withoutField.data.signingKeyCert).toBeUndefined();
    }
  });

  it("rejects a malformed signingKeyCert (fail-closed transport shape)", () => {
    const bad = CertRenewedPayloadSchema.safeParse({
      installId: "inst_909896241b5bb930",
      cert: CERT,
      signingKeyCert: { v: 1, fleetId: "f" }, // missing required fields
    });
    expect(bad.success).toBe(false);
  });

  it("the signingKeyCert schema is .strict() ; rejects a smuggled secret field", () => {
    const bad = CertRenewedPayloadSchema.safeParse({
      installId: "inst_909896241b5bb930",
      cert: CERT,
      signingKeyCert: { ...SIGNING_KEY_CERT, signingPrivKeyHex: "leak" },
    });
    expect(bad.success).toBe(false);
  });

  it("FleetSigningKeyCertSchema carries no secret field ; every field is public", () => {
    const parsed = FleetSigningKeyCertSchema.safeParse(SIGNING_KEY_CERT);
    expect(parsed.success).toBe(true);
    for (const k of Object.keys(SIGNING_KEY_CERT)) {
      expect(k).not.toMatch(/priv|secret|seed|mnemonic/i);
    }
  });

  it("the unknown-type guard still passes it via CANONICAL_ONLY_TYPES", () => {
    // A raw envelope with an unknown payload shape but the known type string is
    // recognised by the permissive guard (the same forward-compat contract the
    // other CUSTOM_* types rely on).
    const raw: unknown = {
      type: "CUSTOM_FLEET_CERT_RENEWED",
      id: "evt_x",
      seq: 0,
      ts: new Date().toISOString(),
      data: {},
    };
    expect(isKnownEventType((raw as { type: string }).type)).toBe(true);
  });
});
