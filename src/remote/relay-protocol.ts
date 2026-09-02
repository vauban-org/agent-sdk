/**
 * remote/relay-protocol — the wire contract for the sovereign relay.
 *
 * The relay is a zero-knowledge rendezvous: the PC ("host") and the phone
 * ("guest") both dial OUT to it (no inbound ports, NAT-friendly); the relay
 * forwards opaque ciphertext frames host↔guest and never decrypts them.
 *
 * Two layers:
 *   - the RELAY layer (this file's HTTP paths + `RelayFrame`) — what the relay
 *     sees: routing + ciphertext blobs + the public keys exchanged at pairing
 *     (public keys are safe in clear);
 *   - the SESSION layer (`RelayMessage`) — the plaintext INSIDE the E2E
 *     envelope, which only the two endpoints can read.
 *
 * @public @since 2.12.0 — preste remote-control T2
 */

import type { SessionEvent } from "./events.js";

export const RELAY_PROTOCOL_VERSION = 1;

// ─── Pairing payload — goes in the QR / pairing link ─────────────────────────

/**
 * Everything the phone needs to join a session. Encoded into the QR the PC
 * shows. Contains the host's X25519 public key — public, safe to display.
 * The `pairingToken` is a one-time secret: whoever joins with it becomes the
 * guest, so the QR must be shown only to the intended phone.
 * @public
 */
export interface PairingPayload {
  v: number;
  relayUrl: string;
  sessionId: string;
  pairingToken: string;
  /** Host's ephemeral X25519 public key, base64 DER (SPKI). */
  hostPubKey: string;
}

/**
 * Encode a pairing payload as a compact `preste-pair://` URL.
 * @public
 */
export function encodePairingPayload(p: PairingPayload): string {
  const json = JSON.stringify(p);
  return `preste-pair://${Buffer.from(json, "utf-8").toString("base64url")}`;
}

/**
 * Decode a `preste-pair://` URL back to a pairing payload. Throws on garbage.
 * @public
 */
export function decodePairingPayload(uri: string): PairingPayload {
  const prefix = "preste-pair://";
  if (!uri.startsWith(prefix)) {
    throw new Error("relay: not a preste-pair:// URI");
  }
  const json = Buffer.from(uri.slice(prefix.length), "base64url").toString("utf-8");
  const p = JSON.parse(json) as PairingPayload;
  if (
    typeof p.relayUrl !== "string" ||
    typeof p.sessionId !== "string" ||
    typeof p.pairingToken !== "string" ||
    typeof p.hostPubKey !== "string"
  ) {
    throw new Error("relay: malformed pairing payload");
  }
  return p;
}

// ─── Relay layer — what the relay routes (it never decrypts `frame`) ─────────

/** One opaque ciphertext frame forwarded host↔guest. */
export interface RelayFrame {
  /** Base64 AES-256-GCM ciphertext — see `crypto.seal`. The relay cannot read it. */
  frame: string;
}

// ─── Session layer — plaintext INSIDE the E2E envelope ───────────────────────

/** A message exchanged between the two endpoints, encrypted end-to-end. */
export type RelayMessage =
  /** host → guest: a live session event. */
  | { kind: "event"; event: SessionEvent }
  /** guest → host: inject a steering instruction. */
  | { kind: "inject"; text: string; whisper: boolean }
  /** guest → host: a HITL verdict. */
  | { kind: "hitl"; requestId: string; approved: boolean }
  /** either direction: a liveness ping. */
  | { kind: "ping" };

// ─── Relay HTTP endpoint paths ───────────────────────────────────────────────

export const relayPaths = {
  /** POST — host registers a session. */
  session: "/relay/session",
  /** POST — guest joins with the pairing token. */
  join: (id: string): string => `/relay/session/${id}/join`,
  /** GET (SSE) — host receives frames from the guest. */
  hostStream: (id: string): string => `/relay/session/${id}/host-stream`,
  /** POST — host sends a frame to the guest. */
  hostSend: (id: string): string => `/relay/session/${id}/host-send`,
  /** GET (SSE) — guest receives frames from the host. */
  guestStream: (id: string): string => `/relay/session/${id}/guest-stream`,
  /** POST — guest sends a frame to the host. */
  guestSend: (id: string): string => `/relay/session/${id}/guest-send`,
} as const;
