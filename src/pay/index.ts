/**
 * @vauban-org/agent-sdk/pay — PayPort barrel.
 *
 * Re-exports the chain-agnostic PayPort interface and the Sepolia STRK
 * adapter. Future adapters (mainnet, EVM, off-chain, …) plug in alongside
 * `starknet-adapter.ts` without touching the port. Per ADR-ECO-031.
 */

export type { PayPort, PayRequest, PayResult } from "./port.js";
export {
  StarknetSepoliaPayAdapter,
  DEFAULT_SEPOLIA_RPC_URL,
  STRK_SEPOLIA_CONTRACT,
  SEPOLIA_EXPLORER_BASE,
  classifyReceipt,
  readBlockNumber,
} from "./starknet-adapter.js";
export type { StarknetSepoliaPayAdapterOptions } from "./starknet-adapter.js";

// PaymentAuthorizationPolicy v1 — the deterministic "may this payment move"
// decision that runs BEFORE any money moves (the Veridex-shaped front half of
// the payment-receipt-chain). See `authorization-policy.ts` for the threat-model
// mapping (T-04/05/06) and the commitment grammar (same JCS canonicalizer as
// the Run Certificate pipeline).
export {
  evaluatePaymentAuthorization,
  computePaymentAuthorizationCommitment,
} from "./authorization-policy.js";
export type {
  PaymentPolicy,
  PaymentFacts,
  PaymentPurpose,
  PaymentAuthorizationVerdict,
  PolicyCheckName,
  PolicyCheckResult,
} from "./authorization-policy.js";
