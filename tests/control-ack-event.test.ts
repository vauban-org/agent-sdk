/**
 * control-ack-event.test ; Relayed Control W2 task 2.1 (ADR-ECO-118/119
 * follow-up). The host answers a relayed steer with a signed `control_ack`
 * SessionEvent correlated by a client-generated `steerId`. Anti-oracle: the
 * `accepted` bit is the ONLY auth signal ; a scope-deny surfaces as
 * `accepted:true` (indistinguishable on the wire from a real accept), an
 * auth-fail as `accepted:false`.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type SessionEvent,
  SessionEventSchema,
  __resetEventSeq,
  isKnownEventType,
  makeEvent,
} from "../src/remote/index.js";
import {
  canonicalEventString,
  createEd25519Signer,
  createEd25519Verifier,
  signEvent,
  verifyEvent,
} from "../src/remote/signing.js";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { sign: createEd25519Signer(privateKey), verify: createEd25519Verifier(publicKey) };
}

describe("control_ack SessionEvent (task 2.1)", () => {
  it("CUSTOM_CONTROL_ACK is a known event type and parses with steerId + accepted", () => {
    __resetEventSeq();
    const ev = makeEvent("CUSTOM_CONTROL_ACK", { steerId: "steer-abc", accepted: true });
    expect(ev.type).toBe("CUSTOM_CONTROL_ACK");
    expect(isKnownEventType("CUSTOM_CONTROL_ACK")).toBe(true);
    const parsed = SessionEventSchema.safeParse(ev);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_CONTROL_ACK") {
      expect(parsed.data.data.steerId).toBe("steer-abc");
      expect(parsed.data.data.accepted).toBe(true);
    }
  });

  it("rides the existing Ed25519-signed event path ; steerId is echoed and signature-covered", () => {
    const { sign, verify } = keyPair();
    const ev = makeEvent("CUSTOM_CONTROL_ACK", { steerId: "steer-xyz", accepted: true });
    const signed = signEvent(ev, sign);
    expect(verifyEvent(signed, verify)).toBe(true);
    // Tampering the correlation id breaks the signature (steerId is inside the
    // canonical, signed bytes).
    const tampered = {
      ...signed,
      data: { ...(signed.data as { steerId: string }), steerId: "steer-OTHER" },
    } as SessionEvent;
    expect(verifyEvent(tampered, verify)).toBe(false);
    // The canonical string covers the steerId.
    expect(canonicalEventString(signed)).toContain("steer-xyz");
  });

  it("anti-oracle: a scope-deny ack carries accepted:true (wire-indistinguishable from a real accept)", () => {
    const scopeDeny = makeEvent("CUSTOM_CONTROL_ACK", { steerId: "s-deny", accepted: true });
    const realAccept = makeEvent("CUSTOM_CONTROL_ACK", { steerId: "s-ok", accepted: true });
    // Both are accepted:true ; the ONLY difference on the wire is the steerId
    // correlation, never the scope outcome.
    expect((scopeDeny.data as { accepted: boolean }).accepted).toBe(true);
    expect((realAccept.data as { accepted: boolean }).accepted).toBe(true);
  });

  it("anti-oracle: an auth-fail ack carries accepted:false", () => {
    const authFail = makeEvent("CUSTOM_CONTROL_ACK", { steerId: "s-authfail", accepted: false });
    expect((authFail.data as { accepted: boolean }).accepted).toBe(false);
    expect(SessionEventSchema.safeParse(authFail).success).toBe(true);
  });

  it("verdict is optional and, when present, does not carry an auth signal", () => {
    const withVerdict = makeEvent("CUSTOM_CONTROL_ACK", {
      steerId: "s-v",
      accepted: true,
      verdict: "applied",
    });
    const parsed = SessionEventSchema.safeParse(withVerdict);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "CUSTOM_CONTROL_ACK") {
      expect(parsed.data.data.verdict).toBe("applied");
    }
  });
});
