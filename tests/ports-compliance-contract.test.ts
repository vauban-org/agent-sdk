import { describe, expect, it } from "vitest";
import {
  type CapabilityInvocation,
  type ComplianceAuditResult,
  type ComplianceContract,
  ComplianceEvaluationTimeoutError,
  type ComplianceGate,
  type ComplianceMode,
  CompliancePolicyError,
  type ComplianceRule,
  type ComplianceViolation,
  type DataClass,
  type EnforcementLevel,
  type Jurisdiction,
  type LegalBasisDomain,
  type LegalBasisRef,
  type ManifestValidationResult,
  type PolicyConflict,
  type RuleSource,
  SUPPORTED_JURISDICTIONS_V0,
  type TenantContext,
} from "../src/ports/compliance-contract.js";

// ─── Error classes ────────────────────────────────────────────────────────────

describe("CompliancePolicyError", () => {
  it("has name CompliancePolicyError", () => {
    const err = new CompliancePolicyError("rule violated", "gdpr-001");
    expect(err.name).toBe("CompliancePolicyError");
  });

  it("is instanceof Error", () => {
    const err = new CompliancePolicyError("violation", "mica-007");
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof CompliancePolicyError", () => {
    const err = new CompliancePolicyError("violation", "mica-007");
    expect(err).toBeInstanceOf(CompliancePolicyError);
  });

  it("stores ruleId", () => {
    const err = new CompliancePolicyError("msg", "tfr-rule-42");
    expect(err.ruleId).toBe("tfr-rule-42");
  });

  it("stores message", () => {
    const err = new CompliancePolicyError("consent required", "gdpr-art6");
    expect(err.message).toBe("consent required");
  });

  it("stores optional cause", () => {
    const cause = new Error("inner");
    const err = new CompliancePolicyError("outer", "rule-1", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when omitted", () => {
    const err = new CompliancePolicyError("msg", "rule-2");
    expect(err.cause).toBeUndefined();
  });
});

describe("ComplianceEvaluationTimeoutError", () => {
  it("has name ComplianceEvaluationTimeoutError", () => {
    const err = new ComplianceEvaluationTimeoutError(5000);
    expect(err.name).toBe("ComplianceEvaluationTimeoutError");
  });

  it("is instanceof Error", () => {
    const err = new ComplianceEvaluationTimeoutError(3000);
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof ComplianceEvaluationTimeoutError", () => {
    const err = new ComplianceEvaluationTimeoutError(3000);
    expect(err).toBeInstanceOf(ComplianceEvaluationTimeoutError);
  });

  it("stores timeoutMs", () => {
    const err = new ComplianceEvaluationTimeoutError(7500);
    expect(err.timeoutMs).toBe(7500);
  });

  it("message includes timeoutMs", () => {
    const err = new ComplianceEvaluationTimeoutError(1200);
    expect(err.message).toContain("1200");
  });

  it("message mentions timed out", () => {
    const err = new ComplianceEvaluationTimeoutError(999);
    expect(err.message).toMatch(/timed out/i);
  });

  it("stores optional cause", () => {
    const cause = new Error("cedar timeout");
    const err = new ComplianceEvaluationTimeoutError(2000, cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("SUPPORTED_JURISDICTIONS_V0", () => {
  it("is an array", () => {
    expect(Array.isArray(SUPPORTED_JURISDICTIONS_V0)).toBe(true);
  });

  it("contains FR.v1", () => {
    expect(SUPPORTED_JURISDICTIONS_V0).toContain("FR.v1");
  });

  it("contains EU.v1", () => {
    expect(SUPPORTED_JURISDICTIONS_V0).toContain("EU.v1");
  });

  it("has exactly 2 elements (V0 scope)", () => {
    expect(SUPPORTED_JURISDICTIONS_V0).toHaveLength(2);
  });

  it("does not contain CH.v1 in V0", () => {
    expect(SUPPORTED_JURISDICTIONS_V0).not.toContain("CH.v1");
  });

  it("does not contain UK.v1 in V0", () => {
    expect(SUPPORTED_JURISDICTIONS_V0).not.toContain("UK.v1");
  });
});

// ─── Type-level shape tests (runtime object construction) ─────────────────────

describe("ComplianceViolation shape", () => {
  it("constructs a valid violation object", () => {
    const v: ComplianceViolation = {
      ruleId: "gdpr-001",
      articleRef: "GDPR Art 6(1)(a)",
      description: "Consent missing",
      severity: "block",
    };
    expect(v.ruleId).toBe("gdpr-001");
    expect(v.severity).toBe("block");
  });

  it("accepts warn severity", () => {
    const v: ComplianceViolation = {
      ruleId: "r1",
      articleRef: "MiCA Art 14",
      description: "Disclosure late",
      severity: "warn",
      remediationHint: "Add disclosure",
    };
    expect(v.severity).toBe("warn");
    expect(v.remediationHint).toBe("Add disclosure");
  });
});

describe("ComplianceGate discriminated union", () => {
  it("proceed gate has warnings array", () => {
    const gate: ComplianceGate = { decision: "proceed", warnings: [] };
    if (gate.decision === "proceed") {
      expect(gate.warnings).toEqual([]);
    }
  });

  it("block gate has violation", () => {
    const violation: ComplianceViolation = {
      ruleId: "r1",
      articleRef: "GDPR Art 6(1)(a)",
      description: "blocked",
      severity: "block",
    };
    const gate: ComplianceGate = { decision: "block", violation };
    if (gate.decision === "block") {
      expect(gate.violation.ruleId).toBe("r1");
    }
  });
});

describe("ManifestValidationResult shape", () => {
  it("valid manifest has empty conflicts", () => {
    const result: ManifestValidationResult = {
      valid: true,
      conflicts: [],
      missingLegalBases: [],
      jurisdictionWarnings: [],
      evaluationTimeMs: 42,
    };
    expect(result.valid).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.evaluationTimeMs).toBe(42);
  });

  it("invalid manifest has CONFLICT_UNDETERMINED on timeout", () => {
    const conflict: PolicyConflict = {
      rule1Id: "r1",
      rule2Id: "r2",
      description: "Cedar timeout",
      status: "CONFLICT_UNDETERMINED",
    };
    const result: ManifestValidationResult = {
      valid: false,
      conflicts: [conflict],
      missingLegalBases: ["mica.art14"],
      jurisdictionWarnings: [],
      evaluationTimeMs: 5000,
    };
    expect(result.conflicts[0].status).toBe("CONFLICT_UNDETERMINED");
    expect(result.missingLegalBases).toContain("mica.art14");
  });
});

describe("ComplianceContract shape", () => {
  it("constructs a minimal valid contract", () => {
    const contract: ComplianceContract = {
      jurisdictions: ["EU.v1"],
      legal_bases: [{ domain: "processing", basis: "gdpr.art6_1_a" }],
      data_class: "confidential",
      mode: "strict",
      tier: "institutional",
      rules: [],
      retention: "P7Y",
    };
    expect(contract.mode).toBe("strict");
    expect(contract.retention).toBe("P7Y");
    expect(contract.data_class).toBe("confidential");
  });

  it("accepts audit_only mode", () => {
    const contract: ComplianceContract = {
      jurisdictions: ["FR.v1"],
      legal_bases: [],
      data_class: "internal",
      mode: "audit_only",
      tier: "sandbox",
      rules: [],
      retention: "P1Y",
      audit_format: "json",
    };
    expect(contract.mode).toBe("audit_only");
    expect(contract.audit_format).toBe("json");
  });
});

describe("CapabilityInvocation shape", () => {
  it("constructs a minimal invocation", () => {
    const inv: CapabilityInvocation = {
      action: "bastion.swap",
      tenantId: "tenant-abc",
      dataClass: "internal",
    };
    expect(inv.action).toBe("bastion.swap");
    expect(inv.dataClass).toBe("internal");
  });

  it("accepts optional legalBasis and jurisdiction", () => {
    const inv: CapabilityInvocation = {
      action: "brain.archive",
      tenantId: "t1",
      dataClass: "confidential",
      legalBasis: "gdpr.art6_1_b",
      jurisdiction: "FR.v1",
      requiresConsent: true,
      requiresVerifiedHuman: false,
      stepIndex: 3,
      workflowRunId: "run-xyz",
    };
    expect(inv.legalBasis).toBe("gdpr.art6_1_b");
    expect(inv.jurisdiction).toBe("FR.v1");
    expect(inv.stepIndex).toBe(3);
  });
});

describe("TenantContext shape", () => {
  it("constructs a verified tenant context", () => {
    const ctx: TenantContext = {
      tenantId: "t1",
      glacisMode: "verified",
      verifiedHuman: true,
      jurisdictions: ["EU.v1", "FR.v1"],
    };
    expect(ctx.glacisMode).toBe("verified");
    expect(ctx.verifiedHuman).toBe(true);
  });

  it("accepts degraded_verified glacis mode", () => {
    const ctx: TenantContext = {
      tenantId: "t2",
      glacisMode: "degraded_verified",
      verifiedHuman: false,
      jurisdictions: ["EU.v1"],
    };
    expect(ctx.glacisMode).toBe("degraded_verified");
  });
});
