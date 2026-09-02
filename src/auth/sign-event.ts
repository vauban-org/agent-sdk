/**
 * sign-event — HMAC-SHA256 event signing helpers.
 *
 * ADR-ECO-017 canonical signature scheme:
 *   HMAC-SHA256(key, type|source|timestamp|idempotencyKey|sha256(payload))
 *
 * IMPORTANT: This is the ONLY place in the codebase where crypto.createHmac
 * is permitted for event signing. Direct usage outside this file is forbidden
 * (enforced by CI lint rule no-direct-hmac-outside-sdk).
 *
 * @module auth/sign-event
 * @public
 */

import { createHash, createHmac } from "node:crypto";
import type { DomainEvent } from "../ports/event-bus.js";

/**
 * Builds the canonical string used as HMAC input.
 * Format: type|source|timestamp|idempotencyKey|sha256(payload)
 * @public
 */
export function canonicalEventString(
  event: Omit<DomainEvent, "signature">,
  payloadHash: string,
): string {
  return [event.type, event.source, event.timestamp, event.idempotencyKey, payloadHash].join("|");
}

/**
 * Signs an event using HMAC-SHA256 with the provided secret.
 *
 * @param event  - Event without signature field.
 * @param secret - HMAC key (hex string or raw string).
 * @returns Lowercase hex MAC (64 chars).
 * @public
 */
export function signEvent(event: Omit<DomainEvent, "signature">, secret: string): string {
  const payloadHash = createHash("sha256").update(JSON.stringify(event.payload)).digest("hex");
  const data = canonicalEventString(event, payloadHash);
  return createHmac("sha256", secret).update(data).digest("hex");
}
