/**
 * remote/crypto — end-to-end encryption for relayed remote-control.
 *
 * When a session is relayed (T2), the relay forwards frames between the PC
 * and the phone but MUST NOT be able to read them — it is a zero-knowledge
 * rendezvous point. This module gives the two endpoints a shared symmetric
 * key they derive WITHOUT the relay ever seeing it:
 *
 *   1. Each side generates an ephemeral X25519 keypair (per session).
 *   2. Public keys are exchanged through the relay (public — safe to relay).
 *   3. Each side does X25519 ECDH → the same shared secret.
 *   4. HKDF-SHA256, salted by the sessionId, → a 32-byte AES-256-GCM key.
 *   5. Every frame is sealed with AES-256-GCM (random IV + auth tag).
 *
 * The relay sees only ciphertext. Forward-secret per session (ephemeral keys).
 * Zero new dependencies — Node's built-in `crypto` covers X25519, HKDF, GCM.
 *
 * @public @since 2.12.0 — preste remote-control T2
 */

import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** An ephemeral X25519 keypair for one relayed session. */
export interface SessionKeyPair {
  privateKey: KeyObject;
  /** DER (SPKI) public key, base64 — safe to put in a QR / send via the relay. */
  publicKeyB64: string;
}

/** HKDF `info` — domain-separates this key from any other use of the secret. */
const HKDF_INFO = Buffer.from("preste-remote-control-v1");

/**
 * Generate an ephemeral X25519 keypair. Call once per relayed session, on
 * each endpoint. The private key never leaves the process.
 */
export function generateSessionKeyPair(): SessionKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey,
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Re-import a base64 DER (SPKI) X25519 public key sent by the peer. */
export function importPublicKey(publicKeyB64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    type: "spki",
    format: "der",
  });
}

/** Re-import a base64 DER (PKCS8) X25519 private key (test/persistence use). */
export function importPrivateKey(privateKeyB64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    type: "pkcs8",
    format: "der",
  });
}

/**
 * Derive the shared AES-256-GCM key from this side's private key and the
 * peer's public key. Both endpoints, given matching keys + the same
 * `sessionId`, derive the IDENTICAL 32-byte key. The relay cannot — it never
 * holds a private key.
 */
export function deriveSharedKey(
  myPrivate: KeyObject,
  peerPublicKeyB64: string,
  sessionId: string,
): Buffer {
  const shared = diffieHellman({
    privateKey: myPrivate,
    publicKey: importPublicKey(peerPublicKeyB64),
  });
  // HKDF salted by the sessionId — binds the key to this exact session.
  const derived = hkdfSync("sha256", shared, Buffer.from(sessionId), HKDF_INFO, 32);
  return Buffer.from(derived);
}

/**
 * Seal a plaintext string into a relay frame.
 *
 * Frame layout (base64 of): `IV(12) || ciphertext || authTag(16)`.
 * A fresh random IV per call — never reused under the same key.
 */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Open a relay frame back to plaintext.
 *
 * @throws when the frame is malformed OR the auth tag does not verify — a
 *         tampered or relay-injected frame is rejected, never returned.
 */
export function open(key: Buffer, frameB64: string): string {
  const buf = Buffer.from(frameB64, "base64");
  if (buf.length < 12 + 16) {
    throw new Error("remote/crypto: frame too short");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
}
