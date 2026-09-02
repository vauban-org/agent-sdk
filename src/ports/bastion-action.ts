/**
 * BastionActionPort — host adapter for Bastion DeFi capabilities.
 *
 * Implements the manifest ∩ client_policies validation gate (T-E invariant).
 * All actions must pass through validateAgainstClientPolicies before HTTP execution.
 *
 * Source: MASTER-PLAN-v5.md §1.3.1, §2.3 (Q-Bastion-1..4)
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type TokenAddress = string & { readonly __brand: "TokenAddress" };
export type VaultAddress = string & { readonly __brand: "VaultAddress" };
/** @public */
export type TenantId = string;

/** @public */
export interface SwapParams {
  readonly token_in: TokenAddress;
  readonly token_out: TokenAddress;
  readonly amount: string; // wei/felt252 numeric string
  readonly max_slippage_bps: number; // basis points [0, 10000]
  readonly deadline: number; // Unix timestamp
}

/** @public */
export interface DepositParams {
  readonly vault_address: VaultAddress;
  readonly amount: string;
  readonly token: TokenAddress;
}

/** @public */
export interface WithdrawParams {
  readonly vault_address: VaultAddress;
  readonly shares: string;
}

/** @public */
export interface TransferParams {
  readonly recipient: string;
  readonly amount: string;
  readonly token: TokenAddress;
}

/** @public */
export interface ActionContext {
  readonly tenantId: TenantId;
  readonly manifestHash: string; // sha256 hex
  readonly runId: string; // workflow run id
  readonly legalBasis?: string; // TFR Art 4 or equivalent
  readonly jurisdictionsContext?: string[];
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** @public */
export interface SwapResult {
  readonly tx_hash: string;
  readonly amount_out: string;
  readonly actual_slippage_bps: number;
  readonly executed_at: Date;
}

/** @public */
export interface DepositResult {
  readonly tx_hash: string;
  readonly shares_minted: string;
  readonly deposit_amount: string;
}

/** @public */
export interface WithdrawResult {
  readonly tx_hash: string;
  readonly amount_withdrawn: string;
}

/** @public */
export interface TransferResult {
  readonly tx_hash: string;
  readonly recipient: string;
  readonly amount: string;
}

// ─── Client policies (runtime constraints) ────────────────────────────────

/** @public */
export interface ClientPolicy {
  readonly max_slippage_bps: number;
  readonly allowed_pairs: readonly [TokenAddress, TokenAddress][];
  readonly daily_volume_cap: string; // wei
  readonly deposit_cap: string; // wei
  readonly allowed_actions: readonly ("swap" | "deposit" | "withdraw" | "transfer")[];
  readonly cache_ttl_seconds: number;
}

/** @public */
export interface PolicyValidation {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly policy_hash?: string;
}

// ─── Port interface ────────────────────────────────────────────────────────

/** @public */
export interface BastionActionPort {
  /**
   * Swap tokens on Bastion CoW intents.
   * Throws BastionSlippageExceededError if actual slippage > max_slippage_bps.
   */
  swap(params: SwapParams, ctx: ActionContext): Promise<SwapResult>;

  /**
   * Deposit into a Bastion vault.
   * Throws BastionInsufficientFundsError if user balance < amount.
   */
  deposit(params: DepositParams, ctx: ActionContext): Promise<DepositResult>;

  /**
   * Withdraw shares from a Bastion vault.
   */
  withdraw(params: WithdrawParams, ctx: ActionContext): Promise<WithdrawResult>;

  /**
   * Transfer tokens. Requires legalBasis in ctx per TFR Art 4.
   * Throws BastionTransferUnauthorizedError if legalBasis absent.
   */
  transfer(params: TransferParams, ctx: ActionContext): Promise<TransferResult>;

  /**
   * Validate action against manifest ∩ client_policies intersection (T-E invariant).
   * Caches client_policies for tenant TTL 60s; invalidation event-driven.
   * Throws BastionPolicyViolationError if action ∉ intersection.
   */
  validateAgainstClientPolicies(
    action: "swap" | "deposit" | "withdraw" | "transfer",
    tenantId: TenantId,
    params?: Partial<SwapParams & DepositParams>,
  ): Promise<PolicyValidation>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────

/** @public */
export class BastionPolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly action: string,
    public readonly tenantId: TenantId,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BastionPolicyViolationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class BastionInsufficientFundsError extends Error {
  constructor(
    public readonly required: string,
    public readonly available: string,
    public readonly cause?: unknown,
  ) {
    super(`Insufficient funds: required ${required}, available ${available}`);
    this.name = "BastionInsufficientFundsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class BastionSlippageExceededError extends Error {
  constructor(
    public readonly max_slippage_bps: number,
    public readonly actual_slippage_bps: number,
    public readonly cause?: unknown,
  ) {
    super(`Slippage exceeded: max ${max_slippage_bps} bps, actual ${actual_slippage_bps} bps`);
    this.name = "BastionSlippageExceededError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class BastionContractError extends Error {
  constructor(
    public readonly contract_call: string,
    public readonly contract_error: string,
    public readonly cause?: unknown,
  ) {
    super(`Contract error on ${contract_call}: ${contract_error}`);
    this.name = "BastionContractError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class BastionTransferUnauthorizedError extends Error {
  constructor(
    message: string,
    public readonly reason: "missing_legal_basis" | "jurisdiction_blocked",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BastionTransferUnauthorizedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
