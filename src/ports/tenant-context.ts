/**
 * TenantContextPort — tenant isolation primitive (S2 spec).
 *
 * TenantContext is the canonical cross-product isolation identifier.
 * canonical_id = poseidon(glacis_nullifier_root, "vauban.platform.v1")
 *
 * 3 modes: 'verified' (Glacis PoH passed) | 'degraded_verified' (fallback during Glacis downtime)
 * | 'unverified' (dev/test, limited capabilities).
 *
 * §5.4 Cumulative degraded cap: ≤30 days per 90-day rolling window.
 * Invariants: I-S2-1..10 per S2 spec.
 */

// ─── Mode types ───────────────────────────────────────────────────────────────

export type TenantMode = "verified" | "degraded_verified" | "unverified";

// ─── TenantContext (S2 §3.1) ──────────────────────────────────────────────────

export interface TenantContext {
  readonly canonical_id: string; // Poseidon hash (Felt252), hex-encoded
  readonly mode: TenantMode;
  readonly kek_id: string; // KEK identifier (KMS reference, NOT the key itself)
  readonly jurisdictions: string[]; // e.g. ["FR.v1", "EU.v1"]
  readonly verified_human: boolean; // true if human identity proven by Glacis PoH
  readonly glacis_attestation_ref?: string; // mainnet tx ref (verified mode)
  readonly degraded_since?: Date; // when did degraded mode start
}

// ─── Degraded mode metrics (§5.4.2) ──────────────────────────────────────────

/** @public */
export interface DegradedMetrics {
  readonly total_degraded_last_90d: number; // seconds
  readonly episodes_count: number;
  readonly pct_time_degraded: number; // 0-100, decimal
}

// ─── Claim types ──────────────────────────────────────────────────────────────

export interface DegradedModeEnteredClaim {
  readonly tenant_id: string;
  readonly reason: string; // e.g. "glacis.downtime", "temporary.mitigation"
  readonly entered_at: Date;
  readonly window_remaining_seconds?: number;
}

export interface DegradedModeExhaustedClaim {
  readonly tenant_id: string;
  readonly total_degraded_90d_seconds: number;
  readonly cap_seconds: number; // 30 * 86400
  readonly fallback_mode: "unverified";
  readonly exhausted_at: Date;
}

// ─── TenantContextPort ─────────────────────────────────────────────────────────

/** @public */
export interface TenantContextPort {
  /**
   * Get current tenant context by ID.
   * Returns null if tenant does not exist or has been revoked.
   */
  getCurrent(tenantId: string): Promise<TenantContext | null>;

  /**
   * Enter degraded mode due to Glacis downtime or other temporary issue.
   * Emits DegradedModeEnteredClaim.
   * Throws TenantNotFoundError if tenant does not exist.
   * Throws DegradedModeExhaustedError if 30/90d cap already exceeded.
   *
   * Precondition: tenant.mode = 'verified'
   * Effect: tenant.mode = 'degraded_verified', tenant.degraded_since = now()
   */
  enterDegradedMode(tenantId: string, reason: string): Promise<void>;

  /**
   * Restore verified mode from degraded mode after Glacis recovery.
   * Verifies the provided Glacis attestation is valid before accepting.
   *
   * Precondition: tenant.mode = 'degraded_verified'
   * Effect: tenant.mode = 'verified', tenant.degraded_since = null
   * Throws InvalidGlacisAttestationError if attestation invalid or expired
   */
  restoreVerified(
    tenantId: string,
    glacisAttestation: {
      txRef: string;
      nullifierRoot: string;
      blockNumber: number;
    },
  ): Promise<void>;

  /**
   * Get KEK (Key Encryption Key) identifier for a tenant.
   * Returns the KMS reference string, NOT the key material itself.
   * Throws TenantNotFoundError if tenant does not exist.
   */
  getKek(tenantId: string): Promise<string>;

  /**
   * Compute cumulative degraded time in the rolling window.
   * windowDays defaults to 90 if not specified.
   * Returns time in seconds.
   */
  getCumulativeDegradedTime(tenantId: string, windowDays?: number): Promise<number>;

  /**
   * Get metrics for custody due diligence reporting.
   * Throws TenantNotFoundError if tenant does not exist.
   */
  getDegradedMetrics(tenantId: string): Promise<DegradedMetrics>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class TenantNotFoundError extends Error {
  constructor(public readonly tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = "TenantNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class DegradedModeExhaustedError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly totalDegradedSeconds: number,
    public readonly capSeconds: number,
  ) {
    super(
      `Degraded mode cap exhausted for tenant ${tenantId}: ` +
        `${totalDegradedSeconds}s ≥ ${capSeconds}s (30 days)`,
    );
    this.name = "DegradedModeExhaustedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class InvalidGlacisAttestationError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly reason: string,
  ) {
    super(`Invalid Glacis attestation for tenant ${tenantId}: ${reason}`);
    this.name = "InvalidGlacisAttestationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
