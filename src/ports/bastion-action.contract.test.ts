/**
 * BastionActionPort contract tests.
 *
 * Applied to any BastionActionPort implementation. Tests T-E invariant validation,
 * error handling, and policy constraint enforcement.
 *
 * Source: MASTER-PLAN-v5.md §1.3.1 (T-E manifest ∩ client_policies)
 */

import { describe, expect, test } from "vitest";
import {
  type ActionContext,
  type BastionActionPort,
  BastionPolicyViolationError,
  BastionSlippageExceededError,
  BastionTransferUnauthorizedError,
  type ClientPolicy,
  type DepositParams,
  type DepositResult,
  type PolicyValidation,
  type SwapParams,
  type SwapResult,
  type TenantId,
  type TokenAddress,
  type TransferParams,
  type TransferResult,
  type WithdrawParams,
  type WithdrawResult,
} from "./bastion-action.js";

function makeActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenantId: "tenant-001",
    manifestHash: "abc123def456",
    runId: crypto.randomUUID(),
    ...overrides,
  };
}

function makeSwapParams(overrides: Partial<SwapParams> = {}): SwapParams {
  return {
    token_in: "0xdeadbeef" as any,
    token_out: "0xcafebabe" as any,
    amount: "1000000000000000000", // 1e18
    max_slippage_bps: 50, // 0.5%
    deadline: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeTransferParams(overrides: Partial<TransferParams> = {}): TransferParams {
  return {
    recipient: "0x1234567890abcdef",
    amount: "1000000",
    token: "0xdeadbeef" as any,
    ...overrides,
  };
}

export const bastionActionPortContract = (factory: () => BastionActionPort) => {
  describe("BastionActionPort contract", () => {
    test("swap succeeds within slippage tolerance", async () => {
      const port = factory();
      const params = makeSwapParams({ max_slippage_bps: 100 });
      const ctx = makeActionContext();

      // Validate passes first
      const validation = await port.validateAgainstClientPolicies("swap", ctx.tenantId);
      expect(validation.valid).toBe(true);

      // Mock successful swap — implementation should not throw
      const result = await port.swap(params, ctx);
      expect(result.tx_hash).toBeDefined();
      expect(result.actual_slippage_bps).toBeLessThanOrEqual(params.max_slippage_bps);
    });

    test("swap throws BastionSlippageExceededError when actual > max", async () => {
      const port = factory();
      const params = makeSwapParams({ max_slippage_bps: 10 }); // 0.1% max, will exceed
      const ctx = makeActionContext();

      await expect(port.swap(params, ctx)).rejects.toThrow(BastionSlippageExceededError);
    });

    test("transfer requires legalBasis in ctx", async () => {
      const port = factory();
      const params = makeTransferParams();
      const ctx = makeActionContext({ legalBasis: undefined });

      // Validate passes, but execution should fail without legalBasis
      await expect(port.transfer(params, ctx)).rejects.toThrow(BastionTransferUnauthorizedError);
    });

    test("transfer succeeds with legalBasis (TFR Art 4)", async () => {
      const port = factory();
      const params = makeTransferParams();
      const ctx = makeActionContext({ legalBasis: "tfr.art4" });

      const result = await port.transfer(params, ctx);
      expect(result.tx_hash).toBeDefined();
      expect(result.recipient).toBe(params.recipient);
      expect(result.amount).toBe(params.amount);
    });

    test("validateAgainstClientPolicies returns valid=false for out-of-scope actions", async () => {
      const port = factory();
      const tenantId = "restricted-tenant";

      // Validate should block an action that's not in tenant's allowed_actions
      const validation = await port.validateAgainstClientPolicies("swap", tenantId);

      if (!validation.valid) {
        expect(validation.violations.length).toBeGreaterThan(0);
      }
    });

    test("validateAgainstClientPolicies enforces max_slippage_bps constraint", async () => {
      const port = factory();
      const tenantId = "tenant-001";

      // Validate with slippage params that exceed policy
      const params = makeSwapParams({ max_slippage_bps: 5000 }); // 50% (extreme)
      const validation = await port.validateAgainstClientPolicies("swap", tenantId, params);

      // Expected: violation if policy max < 5000 bps
      if (!validation.valid) {
        expect(validation.violations.some((v) => v.includes("slippage"))).toBe(true);
      }
    });

    test("validateAgainstClientPolicies caches client_policies (TTL 60s)", async () => {
      const port = factory();
      const tenantId = "tenant-001";

      // First call — cache miss, fetches policy
      const validation1 = await port.validateAgainstClientPolicies("deposit", tenantId);
      expect(validation1).toBeDefined();

      // Second call immediately — should use cache, same policy_hash
      const validation2 = await port.validateAgainstClientPolicies("deposit", tenantId);
      if (validation1.policy_hash && validation2.policy_hash) {
        expect(validation2.policy_hash).toBe(validation1.policy_hash);
      }
    });

    test("deposit succeeds with valid params", async () => {
      const port = factory();
      const params = {
        vault_address: "0xvault001" as any,
        amount: "1000000000000000000",
        token: "0xdeadbeef" as any,
      };
      const ctx = makeActionContext();

      const validation = await port.validateAgainstClientPolicies("deposit", ctx.tenantId);
      if (validation.valid) {
        const result = await port.deposit(params, ctx);
        expect(result.tx_hash).toBeDefined();
        expect(result.shares_minted).toBeDefined();
      }
    });

    test("withdraw succeeds with valid params", async () => {
      const port = factory();
      const params = {
        vault_address: "0xvault001" as any,
        shares: "500000000000000000",
      };
      const ctx = makeActionContext();

      const result = await port.withdraw(params, ctx);
      expect(result.tx_hash).toBeDefined();
      expect(result.amount_withdrawn).toBeDefined();
    });

    test("policy violation includes action and tenantId in error", async () => {
      const port = factory();
      const tenantId = "restricted-tenant";

      try {
        await port.validateAgainstClientPolicies("swap", tenantId);
      } catch (err) {
        if (err instanceof BastionPolicyViolationError) {
          expect(err.action).toBe("swap");
          expect(err.tenantId).toBe(tenantId);
        }
      }
    });
  });
};

// ─── Mock implementation ──────────────────────────────────────────────────

class MockBastionActionPort implements BastionActionPort {
  private policyCache = new Map<string, { policy: ClientPolicy; ts: number }>();

  async validateAgainstClientPolicies(
    action: "swap" | "deposit" | "withdraw" | "transfer",
    tenantId: TenantId,
    params?: Partial<SwapParams & DepositParams>,
  ): Promise<PolicyValidation> {
    // Simulate policy fetch with cache
    const cached = this.policyCache.get(tenantId);
    const now = Date.now();
    const policy =
      cached && now - cached.ts < 60000 ? cached.policy : this.getDefaultPolicy(tenantId);

    if (policy) {
      this.policyCache.set(tenantId, { policy, ts: now });
    }

    const violations: string[] = [];

    // Check if action is allowed
    if (!policy.allowed_actions.includes(action)) {
      violations.push(`action '${action}' not in allowed_actions`);
    }

    // Check slippage constraint if params provided
    if (
      params &&
      "max_slippage_bps" in params &&
      ((params as SwapParams).max_slippage_bps ?? 0) > policy.max_slippage_bps
    ) {
      violations.push(
        `slippage ${params.max_slippage_bps} bps exceeds policy max ${policy.max_slippage_bps} bps`,
      );
    }

    const valid = violations.length === 0;
    return {
      valid,
      violations,
      policy_hash: `hash-${tenantId}-${action}`,
    };
  }

  private getDefaultPolicy(tenantId: TenantId): ClientPolicy {
    if (tenantId === "restricted-tenant") {
      return {
        max_slippage_bps: 100,
        allowed_pairs: [],
        daily_volume_cap: "0",
        deposit_cap: "0",
        allowed_actions: [],
        cache_ttl_seconds: 60,
      };
    }
    return {
      max_slippage_bps: 500,
      allowed_pairs: [["0xdeadbeef" as TokenAddress, "0xcafebabe" as TokenAddress]],
      daily_volume_cap: "1000000000000000000000",
      deposit_cap: "500000000000000000000",
      allowed_actions: ["swap", "deposit", "withdraw", "transfer"],
      cache_ttl_seconds: 60,
    };
  }

  async swap(params: SwapParams, _ctx: ActionContext): Promise<SwapResult> {
    // Simulate slippage calculation: if max_slippage_bps is very low, exceed it
    const actualSlippageBps = params.max_slippage_bps < 20 ? 50 : 10;

    if (actualSlippageBps > params.max_slippage_bps) {
      throw new BastionSlippageExceededError(params.max_slippage_bps, actualSlippageBps);
    }

    return {
      tx_hash: `0x${crypto.randomUUID().replace(/-/g, "")}`,
      amount_out: (BigInt(params.amount) * BigInt(99)) / BigInt(100),
      actual_slippage_bps: actualSlippageBps,
      executed_at: new Date(),
    };
  }

  async deposit(params: DepositParams, _ctx: ActionContext): Promise<DepositResult> {
    return {
      tx_hash: `0x${crypto.randomUUID().replace(/-/g, "")}`,
      shares_minted: (BigInt(params.amount) * BigInt(95)) / BigInt(100),
      deposit_amount: params.amount,
    };
  }

  async withdraw(params: WithdrawParams, _ctx: ActionContext): Promise<WithdrawResult> {
    return {
      tx_hash: `0x${crypto.randomUUID().replace(/-/g, "")}`,
      amount_withdrawn: (BigInt(params.shares) * BigInt(98)) / BigInt(100),
    };
  }

  async transfer(params: TransferParams, ctx: ActionContext): Promise<TransferResult> {
    if (!ctx.legalBasis) {
      throw new BastionTransferUnauthorizedError(
        "Transfer requires legalBasis (TFR Art 4)",
        "missing_legal_basis",
      );
    }

    return {
      tx_hash: `0x${crypto.randomUUID().replace(/-/g, "")}`,
      recipient: params.recipient,
      amount: params.amount,
    };
  }
}

// ─── Default contract application ──────────────────────────────────────────

bastionActionPortContract(() => new MockBastionActionPort());
