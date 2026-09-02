/**
 * Tests for the remote-control E2E crypto + relay protocol (T2).
 *
 * The relay is zero-knowledge: it must be cryptographically impossible for it
 * to read a frame. These tests prove the X25519 ECDH → HKDF → AES-256-GCM
 * chain: both endpoints derive the same key, frames round-trip, and any
 * tampering or wrong-key access is rejected.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type PairingPayload,
  RELAY_PROTOCOL_VERSION,
  canonicalEventString,
  createEd25519Signer,
  createEd25519Verifier,
  createRemoteControlHub,
  decodePairingPayload,
  deriveSharedKey,
  encodePairingPayload,
  generateSessionKeyPair,
  makeEvent,
  open,
  relayPaths,
  seal,
  signEvent,
  verifyEvent,
} from "../src/remote/index.js";

describe("remote E2E crypto", () => {
  it("both endpoints derive the identical shared key (X25519 ECDH)", () => {
    const pc = generateSessionKeyPair();
    const phone = generateSessionKeyPair();
    const kPc = deriveSharedKey(pc.privateKey, phone.publicKeyB64, "sid-1");
    const kPhone = deriveSharedKey(phone.privateKey, pc.publicKeyB64, "sid-1");
    expect(kPc.equals(kPhone)).toBe(true);
    expect(kPc.length).toBe(32); // AES-256
  });

  it("the same keypairs under a different sessionId derive a DIFFERENT key", () => {
    const pc = generateSessionKeyPair();
    const phone = generateSessionKeyPair();
    const k1 = deriveSharedKey(pc.privateKey, phone.publicKeyB64, "sid-A");
    const k2 = deriveSharedKey(pc.privateKey, phone.publicKeyB64, "sid-B");
    expect(k1.equals(k2)).toBe(false); // HKDF salted by sessionId
  });

  it("seal → open round-trips a payload", () => {
    const a = generateSessionKeyPair();
    const b = generateSessionKeyPair();
    const key = deriveSharedKey(a.privateKey, b.publicKeyB64, "s");
    const peerKey = deriveSharedKey(b.privateKey, a.publicKeyB64, "s");
    const plaintext = JSON.stringify({ kind: "inject", text: "héllo 漢字" });
    const frame = seal(key, plaintext);
    expect(frame).not.toContain("inject"); // ciphertext, not plaintext
    expect(open(peerKey, frame)).toBe(plaintext);
  });

  it("a fresh IV per seal — identical plaintext yields different frames", () => {
    const a = generateSessionKeyPair();
    const b = generateSessionKeyPair();
    const key = deriveSharedKey(a.privateKey, b.publicKeyB64, "s");
    expect(seal(key, "same")).not.toBe(seal(key, "same"));
  });

  it("rejects a tampered frame (auth tag fails)", () => {
    const a = generateSessionKeyPair();
    const b = generateSessionKeyPair();
    const key = deriveSharedKey(a.privateKey, b.publicKeyB64, "s");
    const frame = seal(key, "secret");
    const tampered = `${frame.slice(0, -6)}AAAAAA`;
    expect(() => open(key, tampered)).toThrow();
  });

  it("rejects a frame opened with the wrong key", () => {
    const a = generateSessionKeyPair();
    const b = generateSessionKeyPair();
    const c = generateSessionKeyPair();
    const key = deriveSharedKey(a.privateKey, b.publicKeyB64, "s");
    const wrong = deriveSharedKey(a.privateKey, c.publicKeyB64, "s");
    expect(() => open(wrong, seal(key, "secret"))).toThrow();
  });

  it("rejects a too-short frame", () => {
    const a = generateSessionKeyPair();
    const b = generateSessionKeyPair();
    const key = deriveSharedKey(a.privateKey, b.publicKeyB64, "s");
    expect(() => open(key, "AAAA")).toThrow(/too short/);
  });
});

describe("relay pairing payload", () => {
  const sample: PairingPayload = {
    v: RELAY_PROTOCOL_VERSION,
    relayUrl: "https://relay.example.test",
    sessionId: "sess-123",
    pairingToken: "tok-abc",
    hostPubKey: generateSessionKeyPair().publicKeyB64,
  };

  it("encodes to a preste-pair:// URI and decodes back", () => {
    const uri = encodePairingPayload(sample);
    expect(uri.startsWith("preste-pair://")).toBe(true);
    expect(decodePairingPayload(uri)).toEqual(sample);
  });

  it("rejects a non-preste-pair URI", () => {
    expect(() => decodePairingPayload("https://evil.test")).toThrow();
  });

  it("rejects a malformed pairing payload", () => {
    const bad = `preste-pair://${Buffer.from('{"v":1}').toString("base64url")}`;
    expect(() => decodePairingPayload(bad)).toThrow(/malformed/);
  });
});

describe("relay path builders", () => {
  it("builds consistent session-scoped paths", () => {
    expect(relayPaths.session).toBe("/relay/session");
    expect(relayPaths.join("x")).toBe("/relay/session/x/join");
    expect(relayPaths.hostStream("x")).toBe("/relay/session/x/host-stream");
    expect(relayPaths.guestSend("x")).toBe("/relay/session/x/guest-send");
  });
});

describe("signed SessionEvent stream (T3)", () => {
  function ed25519() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
      sign: createEd25519Signer(privateKey),
      verify: createEd25519Verifier(publicKey),
    };
  }

  it("signEvent attaches a sig that verifyEvent accepts", () => {
    const { sign, verify } = ed25519();
    const ev = makeEvent("assistant.message", { content: "audited output" });
    const signed = signEvent(ev, sign);
    expect(typeof signed.sig).toBe("string");
    expect(signed.sig!.length).toBeGreaterThan(0);
    expect(verifyEvent(signed, verify)).toBe(true);
  });

  it("verifyEvent rejects an unsigned event", () => {
    const { verify } = ed25519();
    expect(
      verifyEvent(
        makeEvent("run.step", {
          stepIndex: 0,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        }),
        verify,
      ),
    ).toBe(false);
  });

  it("verifyEvent rejects a tampered event (payload mutated post-sign)", () => {
    const { sign, verify } = ed25519();
    const signed = signEvent(makeEvent("assistant.message", { content: "original" }), sign);
    const tampered = {
      ...signed,
      data: { content: "MALICIOUSLY ALTERED" },
    } as typeof signed;
    expect(verifyEvent(tampered, verify)).toBe(false);
  });

  it("verifyEvent rejects a signature from the wrong key", () => {
    const a = ed25519();
    const b = ed25519();
    const signed = signEvent(
      makeEvent("run.step", {
        stepIndex: 1,
        inputTokens: 2,
        outputTokens: 2,
        costUsd: 0.001,
      }),
      a.sign,
    );
    expect(verifyEvent(signed, b.verify)).toBe(false);
  });

  it("canonicalEventString excludes sig and is stable", () => {
    const { sign } = ed25519();
    const ev = makeEvent("assistant.message", { content: "x" });
    const before = canonicalEventString(ev);
    const signed = signEvent(ev, sign);
    // Adding the signature must NOT change the canonical (signed) bytes.
    expect(canonicalEventString(signed)).toBe(before);
  });

  it("a hub with signFn signs every emitted event — all verify", () => {
    const { sign, verify } = ed25519();
    // Since 3.0.0 the hub normalises the type to canonical BEFORE signing,
    // so the verifier always validates the canonical-typed event. Both legacy
    // dotted and already-canonical inputs are covered here.
    const hub = createRemoteControlHub({ signFn: sign });
    hub.emit(
      makeEvent("run.start", {
        runId: "r",
        agentId: "a",
        startedAt: new Date().toISOString(),
      }),
    );
    hub.emit(makeEvent("assistant.message", { content: "done" }));
    const events = hub.backlog();
    expect(events.length).toBe(2);
    // Hub normalises dotted → canonical before signing.
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events[1]?.type).toBe("TEXT_MESSAGE_END");
    for (const e of events) {
      expect(e.sig).toBeDefined();
      expect(verifyEvent(e, verify)).toBe(true);
    }
  });
});
