/**
 * VFinanceActionPort — host adapter for Vauban Finance capabilities.
 *
 * Implements proof_grade tiers (attestation → attestation_custody_compatible → custody).
 * Manages STARK proofs, oracle quorum validation, and per-batch anchoring discipline.
 *
 * Source: MASTER-PLAN-v5.md §2.4 (Q-VF-1, Q-VF-2) — proof_grade gradient + ADR-ECO-017
 * @public
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type PortfolioId = string & { readonly __brand: "PortfolioId" };
export type Symbol = string; // e.g., "BTC/USD", "AAPL"

/** @public */
export type ProofGrade = "attestation" | "attestation_custody_compatible" | "custody";

/** @public */
export interface MarketSignal {
  readonly symbol: Symbol;
  readonly price: string; // decimal numeric string
  readonly timestamp: Date;
  readonly oracle_count: number;
  readonly divergence_bps: number; // max divergence between oracles
}

/** @public */
export interface SolvencyClaim {
  readonly portfolio_id: PortfolioId;
  readonly assets_ge_liabilities: boolean; // ∃ assets ≥ liabilities
  readonly proof_grade: ProofGrade;
  readonly stark_proof?: string; // hex-encoded STARK (None for attestation-only)
  readonly oracle_quorum?: number; // for custody: must be 3-of-4
  readonly timestamp: Date;
}

/** @public */
export interface TradeRecord {
  readonly id: string; // idempotency key, order_id
  readonly side: "buy" | "sell";
  readonly qty: string;
  readonly price: string;
  readonly ts: Date;
}

/** @public */
export interface TradeClaim {
  readonly trade_id: string;
  readonly executed: boolean;
  readonly hmac_signature: string; // HMAC-SHA256 per ADR-ECO-017
  readonly anchor_id?: string; // per-batch anchor (NEVER per-trade)
  readonly timestamp: Date;
}

/** @public */
export interface StrategyRunInput {
  readonly strategy_id: string;
  readonly sprint_id: string;
  readonly dataset_hash: string; // sha256 of walk-forward data
  readonly code_commit: string; // git commit hash
}

/** @public */
export interface StrategyRunClaim {
  readonly strategy_id: string;
  readonly sprint_id: string;
  readonly integrity_proven: boolean;
  readonly proof_commitment: string; // Merkle path to sprint seal
  readonly timestamp: Date;
}

/** @public */
export interface ActionContext {
  readonly tenantId: string;
  readonly runId: string;
  readonly legalBasis?: string;
}

// ─── Port interface ────────────────────────────────────────────────────────

/** @public */
export interface VFinanceActionPort {
  /**
   * Read-only: fetch market signal for symbol (oracle aggregation).
   */
  getMarketSignal(symbol: Symbol, ctx: ActionContext): Promise<MarketSignal>;

  /**
   * Generate solvency proof (range proof for assets ≥ liabilities).
   * proof_grade determines: STARK requirement, oracle quorum.
   * custody (highest assurance): requires oracle_quorum ≥ 3-of-4.
   */
  getSolvencyProof(
    portfolioId: PortfolioId,
    proofGrade: ProofGrade,
    ctx: ActionContext,
  ): Promise<SolvencyClaim>;

  /**
   * Record a trade execution with HMAC-SHA256 signature (ADR-ECO-017).
   * Per-batch anchoring only — throws VFAnchoringForbiddenError if per-trade anchor attempted.
   */
  recordTrade(trade: TradeRecord, ctx: ActionContext): Promise<TradeClaim>;

  /**
   * Submit strategy run to sprint seal (Citadel integration pattern).
   * Returns proof commitment linking to sealed sprint.
   */
  submitStrategyRun(strategy: StrategyRunInput, ctx: ActionContext): Promise<StrategyRunClaim>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────

/** @public */
export class VFOracleQuorumError extends Error {
  constructor(
    public readonly required_quorum: number,
    public readonly available_oracles: number,
    public readonly cause?: unknown,
  ) {
    super(`Oracle quorum required ${required_quorum}, available ${available_oracles}`);
    this.name = "VFOracleQuorumError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class VFProofGradeMismatchError extends Error {
  constructor(
    message: string,
    public readonly expected_grade: ProofGrade,
    public readonly actual_grade: ProofGrade,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VFProofGradeMismatchError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class VFAnchoringForbiddenError extends Error {
  constructor(
    message: string,
    public readonly reason: "per_trade_anchor_forbidden" | "batch_anchor_missing",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VFAnchoringForbiddenError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class VFProofGenerationError extends Error {
  constructor(
    public readonly portfolio_id: PortfolioId,
    public readonly proof_type: "stark_range" | "commitment",
    public readonly cause?: unknown,
  ) {
    super(
      `Proof generation failed for ${portfolio_id} (${proof_type}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "VFProofGenerationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
