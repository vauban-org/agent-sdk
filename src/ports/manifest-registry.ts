/**
 * ManifestRegistryPort — agent manifest registration and lifecycle management (S1 spec).
 *
 * Implements: manifest registration with Ed25519 signatures, lifecycle states
 * (active/deprecated/revoked), version monotonicity, and tier-based compliance gating.
 *
 * Invariants enforced: I-S1-1..12 (capabilities, tier constraints, versioning).
 * Errors: ManifestNotFoundError, ManifestSignatureInvalidError, ManifestVersionConflictError,
 * ManifestComplianceConflictError (from S5 Cedar G-3).
 */

// ─── Tiers ────────────────────────────────────────────────────────────────────

export type Tier = "dev" | "test" | "pilot" | "production" | "internal" | "legacy";

export const SUPPORTED_TIERS: Tier[] = ["dev", "test", "pilot", "production", "internal", "legacy"];

// ─── Compliance modes (S5 §3.1, I-S1-2) ──────────────────────────────────────

export type ComplianceMode = "strict" | "audit_only";

// ─── Manifest representation ───────────────────────────────────────────────────

/** @public */
export interface Manifest {
  readonly name: string; // agent identifier, e.g. vauban.bastion.vault-rebalancer
  readonly version: string; // semver
  readonly tier: Tier;
  readonly compliance_mode: ComplianceMode;
  readonly capabilities: readonly string[]; // e.g. ["bastion.swap", "brain.archive"]
  readonly compliance: {
    readonly jurisdictions: readonly string[];
    readonly legal_bases: readonly string[];
    readonly data_classification: string;
  };
  readonly runtime: {
    readonly max_compute_seconds: number;
    readonly max_llm_tokens: number;
  };
  readonly ed25519_pubkey: string; // hex, 32 bytes
  readonly signature: string; // hex, 64 bytes (Ed25519 signature of manifestHash)
  readonly manifestHash: string; // Poseidon-felt252 or SHA-256 hex
}

// ─── Registration result ───────────────────────────────────────────────────────

export type RegistrationStatus = "registered" | "partial" | "failed";

export interface ComplianceError {
  readonly code: string;
  readonly description: string;
}

/** @public */
export interface RegistrationResult {
  readonly claim_id: string; // UUID for the Claim (registered artifact)
  readonly status: RegistrationStatus;
  readonly manifest_id?: string; // set only if status includes "registered"
  readonly errors?: readonly ComplianceError[];
}

// ─── Registration options ─────────────────────────────────────────────────────

export interface RegisterOptions {
  readonly operatorId?: string; // who registered (audit trail)
  readonly timestamp?: Date;
}

// ─── Lookup result ────────────────────────────────────────────────────────────

export interface LookupResult {
  readonly manifest: Manifest | null;
  readonly status?: "active" | "deprecated" | "revoked";
  readonly deprecated_at?: Date;
  readonly revoked_at?: Date;
  readonly revocation_reason?: string;
}

// ─── ManifestRegistryPort interface ───────────────────────────────────────────

/** @public */
export interface ManifestRegistryPort {
  /**
   * Register a manifest with Ed25519 signature validation.
   * Validates I-S1-1..12 invariants before persisting.
   * Rejects I-S1-2 violation: tier='production' + mode='audit_only'.
   * Returns claim_id (signed Claim artifact) or ComplianceErrors.
   */
  register(manifest: Manifest, options?: RegisterOptions): Promise<RegistrationResult>;

  /**
   * Look up a manifest by name + version.
   * Returns null if not found or revoked.
   * Does not include errors list (use getValidationErrors for detailed checks).
   */
  lookup(name: string, version: string): Promise<Manifest | null>;

  /**
   * Revoke a manifest by claim_id.
   * After revocation, lookup() returns null.
   * Emits revocation event (audit trail).
   * Returns void on success; throws ManifestNotFoundError if claim_id invalid.
   */
  revoke(claim_id: string, reason: string): Promise<void>;

  /**
   * List all versions of a manifest by name, sorted by semver.
   * Returns versions in ascending order (0.1.0 < 1.0.0).
   * Returns empty array if name not found.
   */
  listVersions(name: string): Promise<readonly string[]>;

  /**
   * Validate a manifest signature against its ed25519_pubkey.
   * Recomputes manifestHash and checks signature.
   * Returns true if valid; throws ManifestSignatureInvalidError if invalid.
   */
  verifySignature(manifest: Manifest): Promise<boolean>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class ManifestNotFoundError extends Error {
  constructor(
    public readonly name: string,
    public readonly version: string,
  ) {
    super(`Manifest not found: ${name}@${version}`);
    this.name = "ManifestNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class ManifestSignatureInvalidError extends Error {
  constructor(
    public readonly name: string,
    public readonly version: string,
    public readonly cause?: unknown,
  ) {
    super(`Manifest signature invalid for ${name}@${version}`);
    this.name = "ManifestSignatureInvalidError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class ManifestVersionConflictError extends Error {
  constructor(
    public readonly name: string,
    public readonly version: string,
    public readonly existingStatus: string,
  ) {
    super(`Manifest version conflict: ${name}@${version} already registered as ${existingStatus}`);
    this.name = "ManifestVersionConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class ManifestComplianceConflictError extends Error {
  constructor(
    public readonly name: string,
    public readonly version: string,
    public readonly violation: string,
  ) {
    super(`Compliance violation for ${name}@${version}: ${violation}`);
    this.name = "ManifestComplianceConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class ManifestValidationError extends Error {
  constructor(public readonly violations: readonly ComplianceError[]) {
    super(`Manifest validation failed with ${violations.length} violation(s)`);
    this.name = "ManifestValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
