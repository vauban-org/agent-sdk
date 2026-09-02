/**
 * Event auth errors — typed failures for cross-product event verification.
 *
 * ADR-ECO-017: verifyEvent throws typed errors for each failure mode.
 * Consumers MUST catch and handle these explicitly (no silent ignore).
 *
 * @module auth/errors
 * @public
 */

/**
 * Thrown when the event's HMAC signature does not match the recomputed value.
 * @public
 */
export class InvalidSignatureError extends Error {
  constructor(message = "Event signature is invalid") {
    super(message);
    this.name = "InvalidSignatureError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the event timestamp is outside the acceptable clock skew window.
 * Default window: 5 minutes (±300 000 ms).
 * @public
 */
export class ClockSkewError extends Error {
  readonly skewMs: number;
  constructor(skewMs: number) {
    super(
      `Event timestamp skew (${skewMs}ms) exceeds the allowed window. Possible replay or clock drift.`,
    );
    this.name = "ClockSkewError";
    this.skewMs = skewMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the nonce (idempotencyKey) has already been seen within the TTL window.
 * Indicates a replay attack or duplicate delivery.
 * @public
 */
export class ReplayDetectedError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(
      `Replay detected: idempotencyKey "${idempotencyKey}" has already been processed within the nonce TTL window.`,
    );
    this.name = "ReplayDetectedError";
    this.idempotencyKey = idempotencyKey;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the event's source field is not in the allowed enum.
 * Allowed sources: forge | vauban | vauban-finance | brain | citadel | glacis | cc | tenant
 * @public
 */
export class UnknownSourceError extends Error {
  readonly source: string;
  constructor(source: string) {
    super(
      `Unknown event source: "${source}". Must be one of: forge, vauban, vauban-finance, brain, citadel, glacis, cc, tenant.`,
    );
    this.name = "UnknownSourceError";
    this.source = source;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Fleet cert-chain boundary errors (ADR-ECO-115 ; preste owner-fleet) ───────
//
// These three sit ALONGSIDE the four cross-product event-auth errors above
// because the cross-install teammate boundary (teammate-mailbox.ts's
// runBoundaryChecks) raises both families from ONE ordered pipeline. Each is
// DISTINCT from UnknownSourceError by design (fa0 design spike, teammates-fleet
// -plan.md): an expired or revoked formerly-trusted fleet install is NOT an
// "unknown source" ; collapsing it into UnknownSourceError would make the
// boundary ledger's reason dishonest (red-team HIGH-1). Transport mapping
// (fa3): CertChainInvalid -> 401, CertExpired -> 401, InstallRevoked -> 403.

/**
 * Thrown (or returned in the discriminated verify result) when a fleet install
 * certificate fails chain validation: a root pubkey that does not match the
 * pinned fleet root, an invalid root->signing signature, an install cert
 * signature that does not verify under its signing key, or an installId that
 * does not bind its installPubkey (or a checked external bind). Malformed cert
 * material is also reported here, fail-closed.
 * @public
 */
export class CertChainInvalidError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`Fleet cert chain invalid: ${detail}`);
    this.name = "CertChainInvalidError";
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a fleet install (or signing-key) cert is outside its validity
 * window: now past `notAfter`, or now before `issuedAt` beyond the allowed
 * clock skew. A 7-day `notAfter` is the revocation backstop, so an expired
 * cert is a real trust cutoff, not a soft warning.
 * @public
 */
export class CertExpiredError extends Error {
  readonly now: number;
  readonly notAfter: number;
  constructor(now: number, notAfter: number) {
    super(`Fleet cert outside its validity window: now=${now}, valid until notAfter=${notAfter}.`);
    this.name = "CertExpiredError";
    this.now = now;
    this.notAfter = notAfter;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a fleet install is named by a root-signed revocation statement.
 * Distinct from CertChainInvalid: the cert chain is well-formed and was once
 * trusted ; the install has since been explicitly revoked (next-envelope
 * cutoff, D6).
 * @public
 */
export class InstallRevokedError extends Error {
  readonly installId: string;
  constructor(installId: string) {
    super(`Fleet install revoked: "${installId}".`);
    this.name = "InstallRevokedError";
    this.installId = installId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
