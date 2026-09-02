/**
 * ComplianceContractPort — runtime compliance gate for the Vauban Integration Spine.
 *
 * Implements the G-2 Cedar pivot from S5 spec:
 * - pre-step: block or warn before capability invocation
 * - post-step: audit trail after invocation
 * - validateManifest: conflict detection at registration
 *
 * Cedar policy bundles: eu.gdpr / eu.mica / eu.tfr (V0 scope per S5 Q5.1).
 * @public
 */

// ─── Jurisdictions ────────────────────────────────────────────────────────────

export type Jurisdiction = "FR.v1" | "EU.v1" | "CH.v1" | "UK.v1" | "SG.v1";

/** @public */
export const SUPPORTED_JURISDICTIONS_V0: Jurisdiction[] = ["FR.v1", "EU.v1"];

// ─── Legal basis refs (S5 §4 encoding) ───────────────────────────────────────

/** @public */
export type LegalBasisRef =
  | "gdpr.art6_1_a" // consent
  | "gdpr.art6_1_b" // contract performance
  | "gdpr.art6_1_c" // legal obligation
  | "gdpr.art6_1_f" // legitimate interests
  | "mica.art14" // MiCA disclosure obligation
  | "tfr.art4" // TFR data retention obligation
  | "cjeu.c520_21"; // CJEU C-520/21 mandate path

/** @public */
export type LegalBasisDomain = "processing" | "retention" | "transfer" | "consent";

/** @public */
export interface LegalBasisDecl {
  domain: LegalBasisDomain;
  basis: LegalBasisRef;
  scope?: Jurisdiction[];
}

// ─── Data classification ──────────────────────────────────────────────────────

/** @public */
export type DataClass = "public" | "internal" | "confidential" | "secret";

// ─── Rule model (S5 §3.2) ────────────────────────────────────────────────────

/** @public */
export type EnforcementLevel = "block" | "warn" | "log";
/** @public */
export type RuleSource = "declared" | "normative";

/** @public */
export interface ComplianceRule {
  readonly id: string;
  readonly source: RuleSource;
  readonly jurisdiction: Jurisdiction;
  readonly legal_ref: LegalBasisRef;
  readonly enforcement: EnforcementLevel;
  readonly rationale: string;
  readonly authority?: string; // e.g. "EDPB Guidelines 8/2020"
}

// ─── ComplianceContract (S5 §3.1) ────────────────────────────────────────────

/** @public */
export type ComplianceMode = "strict" | "audit_only";

/** @public */
export interface ComplianceContract {
  readonly jurisdictions: Jurisdiction[];
  readonly legal_bases: LegalBasisDecl[];
  readonly data_class: DataClass;
  readonly mode: ComplianceMode;
  readonly tier: string;
  readonly rules: ComplianceRule[];
  readonly retention: string; // ISO duration e.g. "P7Y"
  readonly audit_format?: "json" | "pdf";
}

// ─── Invocation context ───────────────────────────────────────────────────────

/** @public */
export interface CapabilityInvocation {
  readonly action: string; // e.g. "bastion.swap", "brain.archive", "glacis.attest"
  readonly tenantId: string;
  readonly dataClass: DataClass;
  readonly legalBasis?: LegalBasisRef;
  readonly jurisdiction?: Jurisdiction;
  readonly requiresConsent?: boolean;
  readonly requiresVerifiedHuman?: boolean;
  readonly stepIndex?: number;
  readonly workflowRunId?: string;
}

/** @public */
export interface TenantContext {
  readonly tenantId: string;
  readonly glacisMode: "verified" | "degraded_verified" | "unverified";
  readonly verifiedHuman: boolean;
  readonly jurisdictions: Jurisdiction[];
}

// ─── Decision types ───────────────────────────────────────────────────────────

/** @public */
export interface ComplianceViolation {
  readonly ruleId: string;
  readonly articleRef: string; // e.g. "GDPR Art 6(1)(a)"
  readonly description: string;
  readonly severity: "block" | "warn";
  readonly remediationHint?: string;
}

/** @public */
export type ComplianceGate =
  | { readonly decision: "proceed"; readonly warnings: ComplianceViolation[] }
  | { readonly decision: "block"; readonly violation: ComplianceViolation };

/** @public */
export interface ComplianceAuditResult {
  readonly decision: "proceed" | "block" | "warn";
  readonly violations: ComplianceViolation[];
  readonly auditClaimEmitted: boolean;
  readonly evaluatedRules: number;
}

// ─── Manifest validation ──────────────────────────────────────────────────────

/** @public */
export interface PolicyConflict {
  readonly rule1Id: string;
  readonly rule2Id: string;
  readonly description: string;
  readonly status: "CONFLICT" | "CONFLICT_UNDETERMINED";
}

/** @public */
export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly conflicts: PolicyConflict[];
  readonly missingLegalBases: string[];
  readonly jurisdictionWarnings: string[];
  readonly evaluationTimeMs: number;
}

// ─── Port interface ───────────────────────────────────────────────────────────

/** @public */
export interface ComplianceContractPort {
  /**
   * Pre-step gate — called before any capability invocation.
   * In 'strict' mode: block on first violation.
   * In 'audit_only' mode: never block, accumulate warnings.
   */
  preStep(
    invocation: CapabilityInvocation,
    contract: ComplianceContract,
    ctx: TenantContext,
  ): Promise<ComplianceGate>;

  /**
   * Post-step audit — called after capability invocation to emit audit claims.
   * Always runs regardless of pre-step outcome.
   */
  postStep(
    invocation: CapabilityInvocation,
    contract: ComplianceContract,
    ctx: TenantContext,
  ): Promise<ComplianceAuditResult>;

  /**
   * Manifest validation — called at registration, before any workflow runs.
   * Cedar conflict detection per G-3. Timeout → CONFLICT_UNDETERMINED (not fail).
   */
  validateManifest(
    contract: ComplianceContract,
    opts?: { timeoutMs?: number },
  ): Promise<ManifestValidationResult>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class CompliancePolicyError extends Error {
  constructor(
    message: string,
    public readonly ruleId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CompliancePolicyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class ComplianceEvaluationTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly cause?: unknown,
  ) {
    super(`Compliance evaluation timed out after ${timeoutMs}ms`);
    this.name = "ComplianceEvaluationTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
