/**
 * Tests for src/ports/bastion-action.ts
 *
 * Coverage:
 *   BastionPolicyViolationError  — instanceof, .name, message, .action, .tenantId, .cause
 *   BastionInsufficientFundsError — instanceof, .name, message contains required/available, fields
 *   BastionSlippageExceededError  — instanceof, .name, message contains bps values, fields
 *   BastionContractError          — instanceof, .name, message contains call+error, fields
 *   BastionTransferUnauthorizedError — instanceof, .name, message, .reason, .cause
 */

import { describe, expect, it } from "vitest";
import {
  BastionContractError,
  BastionInsufficientFundsError,
  BastionPolicyViolationError,
  BastionSlippageExceededError,
  BastionTransferUnauthorizedError,
} from "../src/ports/bastion-action.js";

// ─── BastionPolicyViolationError ──────────────────────────────────────────────

describe("BastionPolicyViolationError", () => {
  it("instanceof Error", () => {
    const err = new BastionPolicyViolationError("denied", "swap", "tenant-1");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof BastionPolicyViolationError", () => {
    const err = new BastionPolicyViolationError("denied", "swap", "tenant-1");
    expect(err).toBeInstanceOf(BastionPolicyViolationError);
  });

  it(".name is 'BastionPolicyViolationError'", () => {
    const err = new BastionPolicyViolationError("denied", "swap", "tenant-1");
    expect(err.name).toBe("BastionPolicyViolationError");
  });

  it("message equals the provided message string", () => {
    const err = new BastionPolicyViolationError("action not allowed", "deposit", "t2");
    expect(err.message).toBe("action not allowed");
  });

  it(".action stores the action field", () => {
    const err = new BastionPolicyViolationError("msg", "withdraw", "tenant-abc");
    expect(err.action).toBe("withdraw");
  });

  it(".tenantId stores the tenantId field", () => {
    const err = new BastionPolicyViolationError("msg", "transfer", "my-tenant");
    expect(err.tenantId).toBe("my-tenant");
  });

  it(".cause is stored when provided", () => {
    const cause = new Error("root cause");
    const err = new BastionPolicyViolationError("msg", "swap", "t3", cause);
    expect(err.cause).toBe(cause);
  });

  it(".cause is undefined when not provided", () => {
    const err = new BastionPolicyViolationError("msg", "swap", "t3");
    expect(err.cause).toBeUndefined();
  });
});

// ─── BastionInsufficientFundsError ────────────────────────────────────────────

describe("BastionInsufficientFundsError", () => {
  it("instanceof Error", () => {
    const err = new BastionInsufficientFundsError("1000", "500");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof BastionInsufficientFundsError", () => {
    const err = new BastionInsufficientFundsError("1000", "500");
    expect(err).toBeInstanceOf(BastionInsufficientFundsError);
  });

  it(".name is 'BastionInsufficientFundsError'", () => {
    const err = new BastionInsufficientFundsError("1000", "500");
    expect(err.name).toBe("BastionInsufficientFundsError");
  });

  it("message includes the required amount", () => {
    const err = new BastionInsufficientFundsError("99999", "100");
    expect(err.message).toContain("99999");
  });

  it("message includes the available amount", () => {
    const err = new BastionInsufficientFundsError("99999", "12345");
    expect(err.message).toContain("12345");
  });

  it(".required stores the required field", () => {
    const err = new BastionInsufficientFundsError("5000", "200");
    expect(err.required).toBe("5000");
  });

  it(".available stores the available field", () => {
    const err = new BastionInsufficientFundsError("5000", "200");
    expect(err.available).toBe("200");
  });

  it(".cause is stored when provided", () => {
    const cause = new Error("upstream");
    const err = new BastionInsufficientFundsError("100", "0", cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── BastionSlippageExceededError ─────────────────────────────────────────────

describe("BastionSlippageExceededError", () => {
  it("instanceof Error", () => {
    const err = new BastionSlippageExceededError(50, 120);
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof BastionSlippageExceededError", () => {
    const err = new BastionSlippageExceededError(50, 120);
    expect(err).toBeInstanceOf(BastionSlippageExceededError);
  });

  it(".name is 'BastionSlippageExceededError'", () => {
    const err = new BastionSlippageExceededError(50, 120);
    expect(err.name).toBe("BastionSlippageExceededError");
  });

  it("message includes the max slippage bps", () => {
    const err = new BastionSlippageExceededError(50, 200);
    expect(err.message).toContain("50");
  });

  it("message includes the actual slippage bps", () => {
    const err = new BastionSlippageExceededError(50, 200);
    expect(err.message).toContain("200");
  });

  it(".max_slippage_bps stores the max field", () => {
    const err = new BastionSlippageExceededError(100, 300);
    expect(err.max_slippage_bps).toBe(100);
  });

  it(".actual_slippage_bps stores the actual field", () => {
    const err = new BastionSlippageExceededError(100, 300);
    expect(err.actual_slippage_bps).toBe(300);
  });

  it(".cause is stored when provided", () => {
    const cause = new Error("dex error");
    const err = new BastionSlippageExceededError(10, 50, cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── BastionContractError ─────────────────────────────────────────────────────

describe("BastionContractError", () => {
  it("instanceof Error", () => {
    const err = new BastionContractError("swap_exact_in", "REVERT");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof BastionContractError", () => {
    const err = new BastionContractError("swap_exact_in", "REVERT");
    expect(err).toBeInstanceOf(BastionContractError);
  });

  it(".name is 'BastionContractError'", () => {
    const err = new BastionContractError("swap_exact_in", "REVERT");
    expect(err.name).toBe("BastionContractError");
  });

  it("message includes the contract_call", () => {
    const err = new BastionContractError("deposit_vault", "OVERFLOW");
    expect(err.message).toContain("deposit_vault");
  });

  it("message includes the contract_error", () => {
    const err = new BastionContractError("deposit_vault", "OVERFLOW");
    expect(err.message).toContain("OVERFLOW");
  });

  it(".contract_call stores the call field", () => {
    const err = new BastionContractError("withdraw_shares", "ZERO_SHARES");
    expect(err.contract_call).toBe("withdraw_shares");
  });

  it(".contract_error stores the error field", () => {
    const err = new BastionContractError("withdraw_shares", "ZERO_SHARES");
    expect(err.contract_error).toBe("ZERO_SHARES");
  });

  it(".cause is stored when provided", () => {
    const cause = new Error("starknet rejection");
    const err = new BastionContractError("transfer", "REJECTED", cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── BastionTransferUnauthorizedError ────────────────────────────────────────

describe("BastionTransferUnauthorizedError", () => {
  it("instanceof Error", () => {
    const err = new BastionTransferUnauthorizedError("not allowed", "missing_legal_basis");
    expect(err).toBeInstanceOf(Error);
  });

  it("instanceof BastionTransferUnauthorizedError", () => {
    const err = new BastionTransferUnauthorizedError("not allowed", "missing_legal_basis");
    expect(err).toBeInstanceOf(BastionTransferUnauthorizedError);
  });

  it(".name is 'BastionTransferUnauthorizedError'", () => {
    const err = new BastionTransferUnauthorizedError("not allowed", "missing_legal_basis");
    expect(err.name).toBe("BastionTransferUnauthorizedError");
  });

  it("message equals the provided message", () => {
    const err = new BastionTransferUnauthorizedError(
      "TFR Art 4 legalBasis absent",
      "missing_legal_basis",
    );
    expect(err.message).toBe("TFR Art 4 legalBasis absent");
  });

  it(".reason is 'missing_legal_basis' when set", () => {
    const err = new BastionTransferUnauthorizedError("msg", "missing_legal_basis");
    expect(err.reason).toBe("missing_legal_basis");
  });

  it(".reason is 'jurisdiction_blocked' when set", () => {
    const err = new BastionTransferUnauthorizedError("blocked", "jurisdiction_blocked");
    expect(err.reason).toBe("jurisdiction_blocked");
  });

  it(".cause is stored when provided", () => {
    const cause = new Error("policy engine rejection");
    const err = new BastionTransferUnauthorizedError("blocked", "jurisdiction_blocked", cause);
    expect(err.cause).toBe(cause);
  });

  it(".cause is undefined when not provided", () => {
    const err = new BastionTransferUnauthorizedError("blocked", "missing_legal_basis");
    expect(err.cause).toBeUndefined();
  });
});
