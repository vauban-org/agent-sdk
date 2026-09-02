/**
 * verify-event — HMAC-SHA256 event verification with replay protection.
 *
 * Performs 3 checks in order per ADR-ECO-017:
 *   1. Signature equality (timing-safe via timingSafeEqual)
 *   2. Clock skew within window (default 5 min)
 *   3. Nonce dedup via NonceStore (if provided)
 *
 * Throws typed errors: InvalidSignatureError | ClockSkewError |
 *   ReplayDetectedError | UnknownSourceError
 *
 * @module auth/verify-event
 * @public
 */

import { timingSafeEqual } from "node:crypto";
import type { DomainEvent } from "../ports/event-bus.js";
import {
  ClockSkewError,
  InvalidSignatureError,
  ReplayDetectedError,
  UnknownSourceError,
} from "./errors.js";
import type { NonceStore } from "./nonce-store.js";
import { signEvent } from "./sign-event.js";

/** Valid event sources per ADR-ECO-017. */
const VALID_SOURCES = new Set([
  "forge",
  "vauban",
  "vauban-finance",
  "brain",
  "citadel",
  "glacis",
  "cc",
  "tenant",
]);

/** Default replay window: 5 minutes. */
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Default nonce TTL: 10 minutes. */
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;

/** @public */
export interface VerifyEventOptions {
  /** Maximum allowed clock skew in milliseconds. Default: 300_000 (5 min). */
  maxClockSkewMs?: number;
  /** NonceStore for replay protection. If absent, replay check is skipped. */
  nonceStore?: NonceStore;
  /**
   * Fail-closed switch for the cross-product event bus path (ADR-ECO-017).
   *
   * When `true`, verification REJECTS with {@link ReplayDetectedError} if no
   * `nonceStore` is supplied, instead of silently skipping replay protection.
   * Cross-product consumers MUST set this so that a missing nonce store can
   * never degrade to fail-open (G-01). Default: `false` to preserve the
   * standalone primitive contract used by unit tests and the in-memory bus.
   */
  requireNonceStore?: boolean;
}

/**
 * Verifies a signed DomainEvent.
 *
 * @param event     - The full DomainEvent including signature field.
 * @param secret    - HMAC key used to verify the signature.
 * @param opts      - Optional clock skew tolerance and nonce store.
 * @returns true if the event is valid.
 * @throws {UnknownSourceError}     if event.source is not in the allowed enum.
 * @throws {InvalidSignatureError}  if the HMAC does not match.
 * @throws {ClockSkewError}         if the timestamp is outside the allowed window.
 * @throws {ReplayDetectedError}    if the nonce was already seen (replay attack),
 *   OR if `opts.requireNonceStore` is true and no nonceStore was supplied (fail-closed).
 * @public
 */
export async function verifyEvent(
  event: DomainEvent,
  secret: string,
  opts?: VerifyEventOptions,
): Promise<true> {
  const maxClockSkewMs = opts?.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const nonceStore = opts?.nonceStore;
  const requireNonceStore = opts?.requireNonceStore ?? false;

  // 1. Source validation — before signature check to fail fast on unknown sources
  if (!VALID_SOURCES.has(event.source)) {
    throw new UnknownSourceError(event.source);
  }

  // 2. Signature verification (timing-safe)
  const { signature, ...eventWithoutSig } = event;
  const expected = signEvent(eventWithoutSig, secret);

  // Compare using timing-safe equality to prevent timing attacks
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");

  // Buffers must be same length for timingSafeEqual; if different lengths → invalid
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new InvalidSignatureError();
  }

  // 3. Clock skew check
  const eventTime = Date.parse(event.timestamp);
  const skewMs = Math.abs(Date.now() - eventTime);
  if (skewMs > maxClockSkewMs) {
    throw new ClockSkewError(skewMs);
  }

  // 4. Nonce dedup (replay protection)
  if (nonceStore !== undefined) {
    const isNew = await nonceStore.setNX(event.idempotencyKey, DEFAULT_NONCE_TTL_MS);
    if (!isNew) {
      throw new ReplayDetectedError(event.idempotencyKey);
    }
  } else if (requireNonceStore) {
    // Fail-CLOSED (G-01): the cross-product bus path demands replay protection.
    // No nonce store means we cannot dedup, so reject rather than fail-open.
    throw new ReplayDetectedError(event.idempotencyKey);
  }

  return true;
}
