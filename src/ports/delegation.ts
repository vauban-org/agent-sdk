/**
 * DelegationPort — delegation via → operator (Claim Algebra, S7 spec).
 *
 * Implements capability narrowing (R-1 invariant: child ⊆ parent),
 * chain verification, revocation cascade, and depth limits.
 * Ed25519 signatures, max_depth=5 V0 (configurable 1..10 Enterprise).
 *
 * Spec: docs/plans/PreCarre/canonical/specs/S7.md
 */

// ─── Capability and constraint types ───────────────────────────────────────

export interface Constraint {
  readonly type: string; // e.g. "time_window", "rate_limit", "jurisdiction"
  readonly value: string | number | boolean;
}

/** @public */
export interface CapabilityScope {
  readonly capabilities: ReadonlyArray<string>; // e.g. ["read", "write", "delegate"]
  readonly constraints: ReadonlyArray<Constraint>;
  readonly jurisdictions: ReadonlyArray<string>; // e.g. ["EU.v1", "FR.v1"]
  readonly expires_at: string; // ISO 8601
}

// ─── Delegation claim types ────────────────────────────────────────────────

/** @public */
export interface DelegationClaim {
  readonly id: string; // UUID
  readonly parent_id?: string; // parent claim UUID (undefined for root)
  readonly scope: CapabilityScope;
  readonly ed25519_sig: string; // hex-encoded Ed25519 signature
  readonly ttl: number; // seconds
  readonly issuer: string; // agent_id of delegator
  readonly holder: string; // agent_id of delegatee
  readonly created_at: string; // ISO 8601
  readonly revoked_at?: string | null; // null = not revoked, string = revocation timestamp
}

export interface RootCapability {
  readonly capabilities: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<Constraint>;
  readonly jurisdictions: ReadonlyArray<string>;
  readonly expires_at: string;
}

// ─── Verification result ──────────────────────────────────────────────────────

export interface VerifyChainResult {
  readonly valid: boolean;
  readonly chain_depth: number;
  readonly errors: string[]; // empty if valid
  readonly chain: ReadonlyArray<DelegationClaim>; // path from leaf to root
}

// ─── Revocation options ───────────────────────────────────────────────────────

export interface RevocationOpts {
  readonly reason: string; // audit trail
  readonly cascade?: boolean; // revoke descendants (default true)
}

// ─── DelegationPort interface ─────────────────────────────────────────────────

/** @public */
export interface DelegationPort {
  /**
   * Mint a new delegation from a parent capability or root claim.
   * Enforces R-1 narrowing: delegated scope must be ⊆ parent scope.
   * Returns signed DelegationClaim or throws DelegationNotNarrowingError.
   */
  mintDelegation(
    parent: DelegationClaim | RootCapability,
    narrowed: CapabilityScope,
    opts?: { ttl?: number; issuerId?: string; holderId?: string },
  ): Promise<DelegationClaim>;

  /**
   * Verify a delegation claim chain from leaf to root.
   * Checks: Ed25519 signatures, R-1 narrowing at each step,
   * temporal frame nesting, revocation status, cycle detection, max_depth.
   * Returns VerifyChainResult with full chain or error list.
   */
  verifyChain(claim: DelegationClaim): Promise<VerifyChainResult>;

  /**
   * Revoke a delegation claim.
   * Propagates to all descendants (transitive revocation, ¬Revocation semantics).
   * Returns count of claims revoked (including transitive descendants).
   */
  revoke(claimId: string, opts?: RevocationOpts): Promise<number>;

  /**
   * Get a claim by id (from persistent storage).
   * Returns null if not found.
   */
  getClaim(claimId: string): Promise<DelegationClaim | null>;

  /**
   * Get all claims in a delegation chain from leaf to root.
   * Follows parent_id pointers to build full chain.
   */
  getChain(claimId: string): Promise<DelegationClaim[]>;

  /**
   * Check if a claim is revoked (checks cache + on-chain, TTL 60s).
   * Returns true if revoked, false if valid.
   */
  isRevoked(claimId: string): Promise<boolean>;

  /**
   * Get all descendant claims (transitive children).
   * Used for revocation cascade validation.
   */
  getDescendants(claimId: string): Promise<DelegationClaim[]>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class DelegationNotNarrowingError extends Error {
  constructor(
    public readonly parentId: string,
    public readonly childId: string,
    public readonly violationType: string, // "capability_expansion" | "constraint_removal" | "jurisdiction_expansion"
  ) {
    super(
      `Delegation R-1 narrowing violated (parent=${parentId}, child=${childId}): ${violationType}`,
    );
    this.name = "DelegationNotNarrowingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class DelegationExpiredError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly expiresAt: string,
  ) {
    super(`Delegation claim expired (${claimId}): expires_at=${expiresAt}`);
    this.name = "DelegationExpiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class DelegationRevokedError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly revokedAt: string,
    public readonly reason?: string,
  ) {
    super(`Delegation claim revoked (${claimId}) at ${revokedAt}${reason ? `: ${reason}` : ""}`);
    this.name = "DelegationRevokedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class DelegationChainTooDeepError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly depth: number,
    public readonly maxDepth: number,
  ) {
    super(`Delegation chain exceeds max depth (${claimId}): depth=${depth}, max=${maxDepth}`);
    this.name = "DelegationChainTooDeepError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DelegationSignatureInvalidError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly reason: string,
  ) {
    super(`Delegation signature invalid (${claimId}): ${reason}`);
    this.name = "DelegationSignatureInvalidError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DelegationCycleDetectedError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly cycleSubject: string,
  ) {
    super(`Delegation cycle detected (${claimId}): subject ${cycleSubject} appears in chain`);
    this.name = "DelegationCycleDetectedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DelegationNotFoundError extends Error {
  constructor(public readonly claimId: string) {
    super(`Delegation claim not found: ${claimId}`);
    this.name = "DelegationNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DelegationTemporalFrameError extends Error {
  constructor(
    public readonly claimId: string,
    public readonly reason: string, // "not_yet_valid" | "temporal_nesting_violated"
  ) {
    super(`Delegation temporal frame error (${claimId}): ${reason}`);
    this.name = "DelegationTemporalFrameError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
