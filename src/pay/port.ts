/**
 * PayPort — chain-agnostic payment abstraction.
 *
 * Per ADR-ECO-031 (VPSF Chain-Agnostic Invariant), this port is intentionally
 * abstract over the chain identifier (`network`) and token symbol (`token`).
 * Adapters (Starknet, EVM, off-chain, …) live in sibling files and may further
 * narrow the accepted values. The SDK barrel keeps these as open strings so
 * the port surface does not couple the SDK to any single chain.
 *
 * Security : `senderPrivateKey` is a Tier-1 secret. Implementations MUST NOT
 * log, persist, echo, or include it in any error message. Use `[REDACTED]`
 * if a reference to its presence/absence must be surfaced.
 */

/**
 * A pay request normalized at the SDK boundary. The `amount` is the smallest
 * indivisible unit of the token (e.g. for STRK: 1 STRK = 10n ** 18n). The
 * caller (CLI / agent) is responsible for the human-readable to smallest-unit
 * conversion.
 * @public
 */
export interface PayRequest {
  /** Recipient address (felt252 hex for Starknet ; 0x-prefixed EOA for EVM ; etc.). */
  to: string;
  /** Smallest-unit amount. Must be > 0n. */
  amount: bigint;
  /** Token symbol. SDK-side open string ; adapter validates the supported set. */
  token: string;
  /** Network identifier. SDK-side open string ; adapter validates the supported set. */
  network: string;
  /** Tier-1 secret. Adapter MUST NOT log, persist, or echo. */
  senderPrivateKey: string;
  /** Sender account address (felt252 hex for Starknet). */
  senderAddress: string;
}

/**
 * Result of a pay submission. `status` lifecycle :
 *   submitted → accepted | rejected
 *
 * `txHash` is always present once the adapter has issued the network call.
 * `blockNumber` is only present once the tx is `accepted` and the receipt
 * is available.
 * @public
 */
export interface PayResult {
  /** Transaction hash (0x-prefixed hex). */
  txHash: string;
  /** Block explorer URL for the tx (e.g. https://sepolia.starkscan.co/tx/<hash>). */
  explorerUrl: string;
  /** "submitted" once broadcast ; "accepted" once finalized ; "rejected" on chain refusal. */
  status: "submitted" | "accepted" | "rejected";
  /** Set once status === "accepted". */
  blockNumber?: number;
}

/**
 * PayPort — what every payment adapter implements.
 *
 * Two-step lifecycle on purpose : `pay()` returns as soon as the adapter
 * considers the tx final enough to display to the user (typically "accepted"
 * after a single receipt poll). `waitForAcceptance()` is the explicit
 * long-poll entry point for callers that want to block on finality.
 * @public
 */
export interface PayPort {
  /** Submit a transfer and return when status is at least "accepted". */
  pay(req: PayRequest): Promise<PayResult>;
  /** Poll the chain for the given tx hash until accepted/rejected or timeout. */
  waitForAcceptance(txHash: string, opts?: { timeoutMs?: number }): Promise<PayResult>;
}
