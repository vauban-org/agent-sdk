import { describe, expect, it } from "vitest";
import {
  VFAnchoringForbiddenError,
  VFOracleQuorumError,
  VFProofGenerationError,
  VFProofGradeMismatchError,
} from "../src/ports/vauban-finance-action.js";
import type {
  ActionContext,
  MarketSignal,
  PortfolioId,
  ProofGrade,
  SolvencyClaim,
  StrategyRunClaim,
  StrategyRunInput,
  TradeClaim,
  TradeRecord,
} from "../src/ports/vauban-finance-action.js";

// ─── VFOracleQuorumError ──────────────────────────────────────────────────────

describe("VFOracleQuorumError", () => {
  it("is instanceof Error", () => {
    const err = new VFOracleQuorumError(3, 2);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "VFOracleQuorumError"', () => {
    const err = new VFOracleQuorumError(3, 2);
    expect(err.name).toBe("VFOracleQuorumError");
  });

  it("message contains required_quorum and available_oracles", () => {
    const err = new VFOracleQuorumError(4, 1);
    expect(err.message).toContain("4");
    expect(err.message).toContain("1");
  });

  it("sets required_quorum and available_oracles fields correctly", () => {
    const err = new VFOracleQuorumError(3, 2);
    expect(err.required_quorum).toBe(3);
    expect(err.available_oracles).toBe(2);
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new VFOracleQuorumError(3, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(VFOracleQuorumError);
  });

  it("accepts optional cause", () => {
    const cause = new Error("upstream failure");
    const err = new VFOracleQuorumError(3, 2, cause);
    expect(err.cause).toBe(cause);
  });

  it("cause defaults to undefined when not provided", () => {
    const err = new VFOracleQuorumError(3, 2);
    expect(err.cause).toBeUndefined();
  });

  it("inherits prototype correctly across transpilation boundaries", () => {
    const err = new VFOracleQuorumError(3, 2);
    expect(Object.getPrototypeOf(err)).toBe(VFOracleQuorumError.prototype);
  });
});

// ─── VFProofGradeMismatchError ─────────────────────────────────────────────────

describe("VFProofGradeMismatchError", () => {
  const expected: ProofGrade = "custody";
  const actual: ProofGrade = "attestation";

  it("is instanceof Error", () => {
    const err = new VFProofGradeMismatchError("grade mismatch", expected, actual);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "VFProofGradeMismatchError"', () => {
    const err = new VFProofGradeMismatchError("grade mismatch", expected, actual);
    expect(err.name).toBe("VFProofGradeMismatchError");
  });

  it("message reflects the provided message string", () => {
    const err = new VFProofGradeMismatchError("expected custody got attestation", expected, actual);
    expect(err.message).toContain("expected custody got attestation");
  });

  it("sets expected_grade and actual_grade correctly", () => {
    const err = new VFProofGradeMismatchError("mismatch", expected, actual);
    expect(err.expected_grade).toBe("custody");
    expect(err.actual_grade).toBe("attestation");
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new VFProofGradeMismatchError("mismatch", expected, actual);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(VFProofGradeMismatchError);
  });

  it("accepts optional cause", () => {
    const cause = new Error("proof grading failed");
    const err = new VFProofGradeMismatchError("mismatch", expected, actual, cause);
    expect(err.cause).toBe(cause);
  });

  it("cause defaults to undefined when not provided", () => {
    const err = new VFProofGradeMismatchError("mismatch", expected, actual);
    expect(err.cause).toBeUndefined();
  });

  it("supports attestation_custody_compatible as a valid ProofGrade", () => {
    const mid: ProofGrade = "attestation_custody_compatible";
    const err = new VFProofGradeMismatchError("mismatch", "custody", mid);
    expect(err.expected_grade).toBe("custody");
    expect(err.actual_grade).toBe("attestation_custody_compatible");
  });
});

// ─── VFAnchoringForbiddenError ─────────────────────────────────────────────────

describe("VFAnchoringForbiddenError", () => {
  it("is instanceof Error", () => {
    const err = new VFAnchoringForbiddenError(
      "per-trade anchor forbidden",
      "per_trade_anchor_forbidden",
    );
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "VFAnchoringForbiddenError"', () => {
    const err = new VFAnchoringForbiddenError("per-trade anchor", "per_trade_anchor_forbidden");
    expect(err.name).toBe("VFAnchoringForbiddenError");
  });

  it("message reflects the provided message string", () => {
    const msg = "per-trade anchoring is not allowed";
    const err = new VFAnchoringForbiddenError(msg, "per_trade_anchor_forbidden");
    expect(err.message).toBe(msg);
  });

  it("sets reason to per_trade_anchor_forbidden correctly", () => {
    const err = new VFAnchoringForbiddenError("msg", "per_trade_anchor_forbidden");
    expect(err.reason).toBe("per_trade_anchor_forbidden");
  });

  it("sets reason to batch_anchor_missing correctly", () => {
    const err = new VFAnchoringForbiddenError("msg", "batch_anchor_missing");
    expect(err.reason).toBe("batch_anchor_missing");
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new VFAnchoringForbiddenError("forbidden", "per_trade_anchor_forbidden");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(VFAnchoringForbiddenError);
  });

  it("accepts optional cause", () => {
    const cause = new Error("upstream");
    const err = new VFAnchoringForbiddenError("msg", "batch_anchor_missing", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause defaults to undefined when not provided", () => {
    const err = new VFAnchoringForbiddenError("msg", "per_trade_anchor_forbidden");
    expect(err.cause).toBeUndefined();
  });
});

// ─── VFProofGenerationError ────────────────────────────────────────────────────

describe("VFProofGenerationError", () => {
  const pid = "port-123" as PortfolioId;

  it("is instanceof Error", () => {
    const err = new VFProofGenerationError(pid, "stark_range");
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "VFProofGenerationError"', () => {
    const err = new VFProofGenerationError(pid, "stark_range");
    expect(err.name).toBe("VFProofGenerationError");
  });

  it("message contains portfolio_id", () => {
    const err = new VFProofGenerationError(pid, "stark_range");
    expect(err.message).toContain("port-123");
  });

  it("message contains proof_type", () => {
    const err = new VFProofGenerationError(pid, "commitment");
    expect(err.message).toContain("commitment");
  });

  it("sets portfolio_id and proof_type fields correctly", () => {
    const err = new VFProofGenerationError(pid, "stark_range");
    expect(err.portfolio_id).toBe(pid);
    expect(err.proof_type).toBe("stark_range");
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new VFProofGenerationError(pid, "stark_range");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(VFProofGenerationError);
  });

  it("includes Error cause message in generated message", () => {
    const cause = new Error("prover timed out");
    const err = new VFProofGenerationError(pid, "stark_range", cause);
    expect(err.message).toContain("prover timed out");
  });

  it("includes non-Error cause stringified in message", () => {
    const err = new VFProofGenerationError(pid, "stark_range", "timeout");
    expect(err.message).toContain("timeout");
  });

  it("accepts commitment as proof_type", () => {
    const err = new VFProofGenerationError(pid, "commitment");
    expect(err.proof_type).toBe("commitment");
  });

  it("cause field is accessible", () => {
    const cause = new Error("downstream");
    const err = new VFProofGenerationError(pid, "stark_range", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause defaults to undefined when not provided", () => {
    const err = new VFProofGenerationError(pid, "commitment");
    expect(err.cause).toBeUndefined();
  });
});

// ─── Type structural tests (compile-time guard at runtime) ────────────────────

describe("ActionContext type shape", () => {
  it("accepts valid ActionContext with required fields", () => {
    const ctx: ActionContext = {
      tenantId: "tenant-abc",
      runId: "run-001",
    };
    expect(ctx.tenantId).toBe("tenant-abc");
    expect(ctx.runId).toBe("run-001");
  });

  it("accepts ActionContext with optional legalBasis", () => {
    const ctx: ActionContext = {
      tenantId: "tenant-xyz",
      runId: "run-002",
      legalBasis: "GDPR Art.6(1)(b)",
    };
    expect(ctx.legalBasis).toBe("GDPR Art.6(1)(b)");
  });
});

describe("ProofGrade type coverage", () => {
  it("all three proof grades are valid string literals", () => {
    const grades: ProofGrade[] = ["attestation", "attestation_custody_compatible", "custody"];
    expect(grades).toHaveLength(3);
    for (const g of grades) {
      expect(typeof g).toBe("string");
    }
  });
});
