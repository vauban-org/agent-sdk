/**
 * Tests for domain error classes across port interfaces:
 *   src/ports/tenant-context.ts
 *   src/ports/federation.ts
 *   src/ports/bastion-action.ts
 *   src/ports/vauban-finance-action.ts
 *
 * Coverage:
 *   Each error class: .name, field storage, message content, instanceof chain
 *
 * Ref: test coverage for port error classes (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  BastionContractError,
  BastionInsufficientFundsError,
  BastionPolicyViolationError,
  BastionSlippageExceededError,
  BastionTransferUnauthorizedError,
} from "../src/ports/bastion-action.js";
import {
  FederationDelegationChainError,
  FederationMessageExpiredError,
  FederationRoutingError,
  FederationSignatureInvalidError,
} from "../src/ports/federation.js";
import {
  DegradedModeExhaustedError,
  InvalidGlacisAttestationError,
  TenantNotFoundError,
} from "../src/ports/tenant-context.js";
import {
  VFAnchoringForbiddenError,
  VFOracleQuorumError,
  VFProofGenerationError,
  VFProofGradeMismatchError,
} from "../src/ports/vauban-finance-action.js";

// ─── tenant-context.ts errors ─────────────────────────────────────────────────

describe("TenantNotFoundError", () => {
  it(".name is 'TenantNotFoundError'", () => {
    expect(new TenantNotFoundError("t-1").name).toBe("TenantNotFoundError");
  });

  it("stores tenantId", () => {
    expect(new TenantNotFoundError("tenant-abc").tenantId).toBe("tenant-abc");
  });

  it("message contains tenantId", () => {
    expect(new TenantNotFoundError("tenant-abc").message).toContain("tenant-abc");
  });

  it("instanceof Error and TenantNotFoundError", () => {
    const err = new TenantNotFoundError("t");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TenantNotFoundError);
  });
});

describe("DegradedModeExhaustedError", () => {
  it(".name is 'DegradedModeExhaustedError'", () => {
    const err = new DegradedModeExhaustedError("t-1", 2_592_000, 2_592_000);
    expect(err.name).toBe("DegradedModeExhaustedError");
  });

  it("stores all three fields", () => {
    const err = new DegradedModeExhaustedError("t-1", 2_600_000, 2_592_000);
    expect(err.tenantId).toBe("t-1");
    expect(err.totalDegradedSeconds).toBe(2_600_000);
    expect(err.capSeconds).toBe(2_592_000);
  });

  it("message references tenant and cap", () => {
    const err = new DegradedModeExhaustedError("t-1", 2_600_000, 2_592_000);
    expect(err.message).toContain("t-1");
    expect(err.message).toContain("2592000");
  });
});

describe("InvalidGlacisAttestationError", () => {
  it(".name is 'InvalidGlacisAttestationError'", () => {
    const err = new InvalidGlacisAttestationError("t-1", "expired");
    expect(err.name).toBe("InvalidGlacisAttestationError");
  });

  it("stores tenantId and reason", () => {
    const err = new InvalidGlacisAttestationError("t-1", "nullifier mismatch");
    expect(err.tenantId).toBe("t-1");
    expect(err.reason).toBe("nullifier mismatch");
  });

  it("message contains reason", () => {
    const err = new InvalidGlacisAttestationError("t-1", "block too old");
    expect(err.message).toContain("block too old");
  });
});

// ─── federation.ts errors ─────────────────────────────────────────────────────

describe("FederationSignatureInvalidError", () => {
  it(".name is 'FederationSignatureInvalidError'", () => {
    const err = new FederationSignatureInvalidError("msg-1", "bad sig");
    expect(err.name).toBe("FederationSignatureInvalidError");
  });

  it("stores messageId and reason", () => {
    const err = new FederationSignatureInvalidError("msg-abc", "key mismatch");
    expect(err.messageId).toBe("msg-abc");
    expect(err.reason).toBe("key mismatch");
  });

  it("instanceof FederationSignatureInvalidError", () => {
    expect(new FederationSignatureInvalidError("id", "reason")).toBeInstanceOf(
      FederationSignatureInvalidError,
    );
  });
});

describe("FederationRoutingError", () => {
  it(".name is 'FederationRoutingError'", () => {
    const err = new FederationRoutingError("tenant-1", "no route");
    expect(err.name).toBe("FederationRoutingError");
  });

  it("stores tenantId and reason", () => {
    const err = new FederationRoutingError("tenant-x", "hash ring failure");
    expect(err.tenantId).toBe("tenant-x");
    expect(err.reason).toBe("hash ring failure");
  });

  it("message contains both fields", () => {
    const err = new FederationRoutingError("t-1", "unreachable");
    expect(err.message).toContain("t-1");
    expect(err.message).toContain("unreachable");
  });
});

describe("FederationDelegationChainError", () => {
  it(".name is 'FederationDelegationChainError'", () => {
    const err = new FederationDelegationChainError("msg-1", 3, "scope narrowing");
    expect(err.name).toBe("FederationDelegationChainError");
  });

  it("stores all three fields", () => {
    const err = new FederationDelegationChainError("msg-1", 5, "too deep");
    expect(err.messageId).toBe("msg-1");
    expect(err.chainDepth).toBe(5);
    expect(err.reason).toBe("too deep");
  });

  it("message contains chainDepth", () => {
    const err = new FederationDelegationChainError("msg-1", 7, "err");
    expect(err.message).toContain("7");
  });
});

describe("FederationMessageExpiredError", () => {
  it(".name is 'FederationMessageExpiredError'", () => {
    const err = new FederationMessageExpiredError("msg-1", "2026-01-01T00:00:00Z");
    expect(err.name).toBe("FederationMessageExpiredError");
  });

  it("stores messageId and notAfter", () => {
    const err = new FederationMessageExpiredError("msg-42", "2026-05-01T12:00:00Z");
    expect(err.messageId).toBe("msg-42");
    expect(err.notAfter).toBe("2026-05-01T12:00:00Z");
  });

  it("message contains notAfter", () => {
    const err = new FederationMessageExpiredError("id", "2026-01-01T00:00:00Z");
    expect(err.message).toContain("2026-01-01T00:00:00Z");
  });
});

// ─── bastion-action.ts errors ─────────────────────────────────────────────────

describe("BastionPolicyViolationError", () => {
  it(".name is 'BastionPolicyViolationError'", () => {
    const err = new BastionPolicyViolationError("not allowed", "swap", "t-1");
    expect(err.name).toBe("BastionPolicyViolationError");
  });

  it("stores action and tenantId", () => {
    const err = new BastionPolicyViolationError("err", "withdraw", "tenant-99");
    expect(err.action).toBe("withdraw");
    expect(err.tenantId).toBe("tenant-99");
  });

  it("stores cause when provided", () => {
    const cause = new Error("upstream");
    const err = new BastionPolicyViolationError("msg", "swap", "t-1", cause);
    expect(err.cause).toBe(cause);
  });
});

describe("BastionInsufficientFundsError", () => {
  it(".name is 'BastionInsufficientFundsError'", () => {
    const err = new BastionInsufficientFundsError("100", "50");
    expect(err.name).toBe("BastionInsufficientFundsError");
  });

  it("stores required and available", () => {
    const err = new BastionInsufficientFundsError("1000000", "500000");
    expect(err.required).toBe("1000000");
    expect(err.available).toBe("500000");
  });

  it("message contains both amounts", () => {
    const err = new BastionInsufficientFundsError("100", "50");
    expect(err.message).toContain("100");
    expect(err.message).toContain("50");
  });
});

describe("BastionSlippageExceededError", () => {
  it(".name is 'BastionSlippageExceededError'", () => {
    const err = new BastionSlippageExceededError(50, 75);
    expect(err.name).toBe("BastionSlippageExceededError");
  });

  it("stores max and actual slippage bps", () => {
    const err = new BastionSlippageExceededError(50, 120);
    expect(err.max_slippage_bps).toBe(50);
    expect(err.actual_slippage_bps).toBe(120);
  });

  it("message contains bps values", () => {
    const err = new BastionSlippageExceededError(50, 120);
    expect(err.message).toContain("50");
    expect(err.message).toContain("120");
  });
});

describe("BastionContractError", () => {
  it(".name is 'BastionContractError'", () => {
    const err = new BastionContractError("vault::compound", "revert");
    expect(err.name).toBe("BastionContractError");
  });

  it("stores contract_call and contract_error", () => {
    const err = new BastionContractError("vault::swap", "out of gas");
    expect(err.contract_call).toBe("vault::swap");
    expect(err.contract_error).toBe("out of gas");
  });
});

describe("BastionTransferUnauthorizedError", () => {
  it(".name is 'BastionTransferUnauthorizedError'", () => {
    const err = new BastionTransferUnauthorizedError("blocked", "missing_legal_basis");
    expect(err.name).toBe("BastionTransferUnauthorizedError");
  });

  it("stores reason field", () => {
    const err1 = new BastionTransferUnauthorizedError("err", "missing_legal_basis");
    const err2 = new BastionTransferUnauthorizedError("err", "jurisdiction_blocked");
    expect(err1.reason).toBe("missing_legal_basis");
    expect(err2.reason).toBe("jurisdiction_blocked");
  });
});

// ─── vauban-finance-action.ts errors ─────────────────────────────────────────

describe("VFOracleQuorumError", () => {
  it(".name is 'VFOracleQuorumError'", () => {
    const err = new VFOracleQuorumError(3, 1);
    expect(err.name).toBe("VFOracleQuorumError");
  });

  it("stores required_quorum and available_oracles", () => {
    const err = new VFOracleQuorumError(5, 2);
    expect(err.required_quorum).toBe(5);
    expect(err.available_oracles).toBe(2);
  });

  it("message contains both values", () => {
    const err = new VFOracleQuorumError(3, 1);
    expect(err.message).toContain("3");
    expect(err.message).toContain("1");
  });
});

describe("VFProofGradeMismatchError", () => {
  it(".name is 'VFProofGradeMismatchError'", () => {
    const err = new VFProofGradeMismatchError("mismatch", "B", "C");
    expect(err.name).toBe("VFProofGradeMismatchError");
  });

  it("stores expected_grade and actual_grade", () => {
    const err = new VFProofGradeMismatchError("err", "A", "D");
    expect(err.expected_grade).toBe("A");
    expect(err.actual_grade).toBe("D");
  });
});

describe("VFAnchoringForbiddenError", () => {
  it(".name is 'VFAnchoringForbiddenError'", () => {
    const err = new VFAnchoringForbiddenError("err", "per_trade_anchor_forbidden");
    expect(err.name).toBe("VFAnchoringForbiddenError");
  });

  it("stores reason field", () => {
    const err1 = new VFAnchoringForbiddenError("msg", "per_trade_anchor_forbidden");
    const err2 = new VFAnchoringForbiddenError("msg", "batch_anchor_missing");
    expect(err1.reason).toBe("per_trade_anchor_forbidden");
    expect(err2.reason).toBe("batch_anchor_missing");
  });
});

describe("VFProofGenerationError", () => {
  it(".name is 'VFProofGenerationError'", () => {
    const err = new VFProofGenerationError("portfolio-1", "stark_range");
    expect(err.name).toBe("VFProofGenerationError");
  });

  it("stores portfolio_id and proof_type", () => {
    const err = new VFProofGenerationError("p-42", "commitment");
    expect(err.portfolio_id).toBe("p-42");
    expect(err.proof_type).toBe("commitment");
  });

  it("message includes cause message when Error provided", () => {
    const cause = new Error("prover timeout");
    const err = new VFProofGenerationError("p-1", "stark_range", cause);
    expect(err.message).toContain("prover timeout");
  });

  it("instanceof VFProofGenerationError", () => {
    expect(new VFProofGenerationError("p", "stark_range")).toBeInstanceOf(VFProofGenerationError);
  });
});
