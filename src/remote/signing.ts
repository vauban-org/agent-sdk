/**
 * remote/signing — Ed25519 signatures over the SessionEvent stream.
 *
 * Every `SessionEvent` can carry a `sig` field: an Ed25519 signature over the
 * canonical form of the event. A remote client verifies each event against
 * the agent's public key — so the remote-control transcript is a
 * tamper-evident audit trail. A relay (or anyone) that injects or alters an
 * event is detected: the signature no longer verifies.
 *
 * This is the EU AI Act Art. 12 logging obligation turned into a live,
 * cryptographically-verifiable property — not an after-the-fact log file.
 *
 * The SDK stays key-agnostic: it takes a `SignFn` / `VerifyFn`. A reference
 * Ed25519 pair (`createEd25519Signer` / `createEd25519Verifier`) is provided
 * for callers that have a Node `KeyObject` (preste wires its attestation key).
 *
 * @public @since 2.13.0 — preste remote-control T3
 */

import { type KeyObject, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { SessionEvent } from "./events.js";

/**
 * Signs the canonical event bytes; returns a hex signature.
 * @public
 */
export type SignFn = (canonicalMessage: string) => string;
/**
 * Verifies a hex signature over the canonical event bytes.
 * @public
 */
export type VerifyFn = (canonicalMessage: string, sigHex: string) => boolean;

/**
 * The canonical, signature-excluded string form of an event.
 *
 * The `sig` field is dropped before canonicalisation (you cannot sign a
 * value that contains its own signature), then keys are sorted recursively
 * so the bytes are identical on the signer and the verifier.
 */
export function canonicalEventString(event: SessionEvent): string {
  const { sig: _sig, ...rest } = event;
  return canonicalize(rest as unknown as Record<string, unknown>);
}

/** Return a copy of the event with `sig` set to its Ed25519 signature. */
export function signEvent(event: SessionEvent, sign: SignFn): SessionEvent {
  return { ...event, sig: sign(canonicalEventString(event)) };
}

/**
 * Verify an event's signature. Returns false when `sig` is absent OR the
 * signature does not verify — the caller treats an unsigned event in a signed
 * stream as untrusted.
 */
export function verifyEvent(event: SessionEvent, verify: VerifyFn): boolean {
  if (typeof event.sig !== "string" || event.sig === "") return false;
  try {
    return verify(canonicalEventString(event), event.sig);
  } catch {
    return false;
  }
}

/**
 * Build a `SignFn` from a Node Ed25519 private key. Ed25519 takes `null` as
 * the digest algorithm (it hashes internally).
 * @public
 */
export function createEd25519Signer(privateKey: KeyObject): SignFn {
  return (message: string): string =>
    nodeSign(null, Buffer.from(message, "utf-8"), privateKey).toString("hex");
}

/**
 * Build a `VerifyFn` from a Node Ed25519 public key.
 * @public
 */
export function createEd25519Verifier(publicKey: KeyObject): VerifyFn {
  return (message: string, sigHex: string): boolean =>
    nodeVerify(null, Buffer.from(message, "utf-8"), publicKey, Buffer.from(sigHex, "hex"));
}
