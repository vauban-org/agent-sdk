/**
 * StarknetSepoliaPayAdapter — PayPort impl for STRK transfers on Sepolia.
 *
 * RPC : self-hosted Pathfinder via vauban-infrastructure
 * (`https://sepolia.rpc.vauban.tech/rpc/v0_10`). Per the founder mandate
 * (vauban-gouvernance/.claude/rules/architecture/starknet-rpc-self-hosted.md),
 * SaaS RPC providers (Infura/Alchemy/Blast/QuickNode/…) are FORBIDDEN.
 *
 * Why a Sepolia-only adapter at MVP : mainnet payments are a regulated surface
 * that requires explicit founder approval (Phase 4+). This adapter rejects any
 * `network !== "sepolia"` at the boundary so a CLI bug or a stale config can
 * never accidentally fan out a fund-bearing transaction.
 *
 * Token : STRK is the native gas + transfer token on Starknet Sepolia. The
 * contract address (`STRK_SEPOLIA_CONTRACT`) is exported so callers can
 * cross-check / override in tests, but the value matches the canonical
 * starknet-balance skill (audited 2026-05-22).
 *
 * CEI discipline : (1) Checks — validate `to` is a felt252 hex, `amount > 0`,
 * network = sepolia, token = STRK ; (2) Effects — construct the `transfer`
 * Call ; (3) Interactions — submit the invoke + poll the receipt once.
 *
 * Tier-1 secret discipline : `senderPrivateKey` is forwarded to the `Account`
 * constructor and never stored on `this`. The adapter never logs request
 * payloads ; only `txHash` and explorer URL are surfaced.
 */

import { Account, type Call, RpcProvider } from "starknet";
import type { PayPort, PayRequest, PayResult } from "./port.js";

// ─── Canonical constants ────────────────────────────────────────────────────────

/**
 * Self-hosted Pathfinder RPC, v0.10 spec (per ADR-ECO-031 + starknet-rpc-self-hosted.md).
 * @public
 */
export const DEFAULT_SEPOLIA_RPC_URL = "https://sepolia.rpc.vauban.tech/rpc/v0_10";

/**
 * STRK token contract on Starknet Sepolia.
 *
 * Source : Starknet ecosystem canonical, cross-checked against
 * `packages/agent-sdk/src/skills/starknet-balance.ts:36` (audited 2026-05-22).
 * Confirm at https://sepolia.voyager.online/contract/<addr> if pinning a
 * different revision.
 * @public
 */
export const STRK_SEPOLIA_CONTRACT =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/**
 * Sepolia tx explorer base.
 * @public
 */
export const SEPOLIA_EXPLORER_BASE = "https://sepolia.starkscan.co/tx";

// ─── Validation helpers ─────────────────────────────────────────────────────────

const FELT252_HEX_RE = /^0x[0-9a-fA-F]{1,64}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{1,64}$/;

function isFelt252Hex(value: string): boolean {
  return FELT252_HEX_RE.test(value);
}

function explorerUrlFor(txHash: string): string {
  return `${SEPOLIA_EXPLORER_BASE}/${txHash}`;
}

/**
 * Split a u256 bigint into the two felt252 limbs Starknet expects for ERC-20
 * `transfer(recipient: ContractAddress, amount: u256)`. low + high are each
 * 128-bit unsigned.
 */
function u256Calldata(amount: bigint): [string, string] {
  if (amount < 0n) {
    throw new Error("amount must be non-negative");
  }
  const MASK_128 = (1n << 128n) - 1n;
  const low = amount & MASK_128;
  const high = amount >> 128n;
  return [low.toString(10), high.toString(10)];
}

// ─── Adapter ────────────────────────────────────────────────────────────────────

/** @public */
export interface StarknetSepoliaPayAdapterOptions {
  /** Override the Pathfinder RPC URL. MUST stay self-hosted (no SaaS). */
  rpcUrl?: string;
  /** Override the STRK contract address (test-only). */
  strkContract?: string;
  /** Receipt poll interval in ms (default: 1500). */
  pollIntervalMs?: number;
  /**
   * Provider factory override — used in tests to inject a mocked RpcProvider.
   * The factory receives the resolved RPC URL and MUST return an
   * `RpcProvider`-compatible object (must expose `getTransactionReceipt`).
   */
  providerFactory?: (rpcUrl: string) => RpcProvider;
  /**
   * Account factory override — used in tests to inject a mocked Account.
   * The factory receives the resolved provider, the sender address, and the
   * private key, and MUST return an `Account`-compatible object (must expose
   * `execute`).
   */
  accountFactory?: (provider: RpcProvider, address: string, privateKey: string) => Account;
}

/** @public */
export class StarknetSepoliaPayAdapter implements PayPort {
  private readonly rpcUrl: string;
  private readonly strkContract: string;
  private readonly pollIntervalMs: number;
  private readonly providerFactory: (rpcUrl: string) => RpcProvider;
  private readonly accountFactory: (
    provider: RpcProvider,
    address: string,
    privateKey: string,
  ) => Account;

  constructor(opts: StarknetSepoliaPayAdapterOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_SEPOLIA_RPC_URL;
    this.strkContract = opts.strkContract ?? STRK_SEPOLIA_CONTRACT;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    // starknet's `RpcProvider` / `Account` are mixin classes whose .d.ts
    // signatures don't always expose the constructor parameters and method
    // surface we need ; the runtime accepts the calls cleanly, so we cast
    // through `unknown` to bridge the type gap without losing the runtime
    // contract. Same pattern as `packages/cli/src/cmd-anchor.ts`.
    this.providerFactory =
      opts.providerFactory ??
      ((url) =>
        new (
          RpcProvider as unknown as new (opts: {
            nodeUrl: string;
          }) => RpcProvider
        )({ nodeUrl: url }));
    this.accountFactory =
      opts.accountFactory ??
      ((provider, address, privateKey) => new Account(provider, address, privateKey));
    this._rejectSaasRpc(this.rpcUrl);
  }

  // ─── PayPort.pay ─────────────────────────────────────────────────────────────

  async pay(req: PayRequest): Promise<PayResult> {
    // 1. Checks
    if (req.network !== "sepolia") {
      throw new Error(
        `StarknetSepoliaPayAdapter only supports network="sepolia", got "${req.network}"`,
      );
    }
    if (req.token !== "STRK") {
      throw new Error(
        `StarknetSepoliaPayAdapter only supports token="STRK" at MVP, got "${req.token}"`,
      );
    }
    if (!isFelt252Hex(req.to)) {
      throw new Error("invalid recipient address: not a felt252 hex (0x…)");
    }
    if (!isFelt252Hex(req.senderAddress)) {
      throw new Error("invalid sender address: not a felt252 hex (0x…)");
    }
    if (typeof req.amount !== "bigint" || req.amount <= 0n) {
      throw new Error(`amount must be a positive bigint, got ${String(req.amount)}`);
    }
    if (!req.senderPrivateKey || typeof req.senderPrivateKey !== "string") {
      // NEVER include the actual key value in the message.
      throw new Error("missing senderPrivateKey ([REDACTED])");
    }

    // 2. Effects — construct the Call. ERC-20 transfer takes (recipient: felt, amount: u256).
    const [amountLow, amountHigh] = u256Calldata(req.amount);
    const call: Call = {
      contractAddress: this.strkContract,
      entrypoint: "transfer",
      calldata: [req.to, amountLow, amountHigh],
    };

    // 3. Interactions — provider + account + submit.
    const provider = this.providerFactory(this.rpcUrl);
    const account = this.accountFactory(provider, req.senderAddress, req.senderPrivateKey);
    const submitted = await account.execute(call);
    const txHash = submitted.transaction_hash;
    if (!txHash || !TX_HASH_RE.test(txHash)) {
      throw new Error("adapter received malformed tx_hash from network");
    }

    // Single receipt poll to upgrade status submitted → accepted (or rejected).
    return await this._pollOnce(provider, txHash);
  }

  // ─── PayPort.waitForAcceptance ───────────────────────────────────────────────

  async waitForAcceptance(txHash: string, opts?: { timeoutMs?: number }): Promise<PayResult> {
    if (!TX_HASH_RE.test(txHash)) {
      throw new Error("invalid txHash: not a felt252 hex (0x…)");
    }
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    const provider = this.providerFactory(this.rpcUrl);

    // Loop until the receipt resolves to an accepted/rejected status or we
    // hit the deadline. On transient errors (receipt not yet visible), the
    // provider throws ; we swallow and retry.
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        const result = await this._pollOnce(provider, txHash);
        if (result.status === "accepted" || result.status === "rejected") {
          return result;
        }
      } catch (err) {
        lastErr = err;
      }
      await this._sleep(this.pollIntervalMs);
    }
    const msg = lastErr instanceof Error ? lastErr.message : "deadline";
    throw new Error(`waitForAcceptance timed out for ${txHash}: ${msg}`);
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async _pollOnce(provider: RpcProvider, txHash: string): Promise<PayResult> {
    let receipt: unknown;
    try {
      // Mixin-class typing hides `getTransactionReceipt` at compile time
      // even though it exists at runtime (see `RpcProvider$1` in starknet
      // d.ts). Same `cmd-anchor` runtime contract.
      const p = provider as unknown as {
        getTransactionReceipt: (h: string) => Promise<unknown>;
      };
      receipt = await p.getTransactionReceipt(txHash);
    } catch {
      // Tx may not yet be visible to the sequencer's read replica. Return
      // a "submitted" result so callers can decide whether to poll further.
      return {
        txHash,
        explorerUrl: explorerUrlFor(txHash),
        status: "submitted",
      };
    }
    const status = classifyReceipt(receipt);
    const blockNumber = readBlockNumber(receipt);
    const base: PayResult = {
      txHash,
      explorerUrl: explorerUrlFor(txHash),
      status,
    };
    if (blockNumber !== null) {
      base.blockNumber = blockNumber;
    }
    return base;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Block SaaS RPC URLs at construction time. Aligned with
   * `vauban-gouvernance/.claude/rules/architecture/starknet-rpc-self-hosted.md`.
   */
  private _rejectSaasRpc(url: string): void {
    const banned = [
      "infura.io",
      "alchemy.com",
      "blastapi.io",
      "quicknode.com",
      "helius.dev",
      "chainstack.com",
      "tatum.io",
      "nodereal.io",
      "ankr.com",
    ];
    const lc = url.toLowerCase();
    const hit = banned.find((b) => lc.includes(b));
    if (hit) {
      throw new Error(
        `StarknetSepoliaPayAdapter rejects SaaS RPC "${hit}". Use https://sepolia.rpc.vauban.tech/rpc/v0_10 (per ADR-ECO-031).`,
      );
    }
  }
}

// ─── Receipt classifiers (separate fns so they can be exported & tested) ────────

/**
 * Map a starknet receipt to the PayResult.status enum. starknet 6.x receipts
 * expose `finality_status` and `execution_status` on `RPCSPEC07.TXN_RECEIPT`,
 * but we keep the read defensive so tests can mock minimal shapes.
 * @public
 */
export function classifyReceipt(receipt: unknown): PayResult["status"] {
  if (!receipt || typeof receipt !== "object") return "submitted";
  const r = receipt as {
    finality_status?: string;
    execution_status?: string;
    status?: string;
    isSuccess?: () => boolean;
    isRejected?: () => boolean;
  };

  // starknet 6.x GetTransactionReceiptResponse helper methods.
  if (typeof r.isRejected === "function" && r.isRejected()) {
    return "rejected";
  }
  if (typeof r.isSuccess === "function" && r.isSuccess()) {
    return "accepted";
  }

  const finality = (r.finality_status ?? r.status ?? "").toUpperCase();
  if (finality === "ACCEPTED_ON_L2" || finality === "ACCEPTED_ON_L1" || finality === "RECEIVED") {
    const exec = (r.execution_status ?? "").toUpperCase();
    if (exec === "REVERTED" || finality === "RECEIVED") {
      return finality === "RECEIVED" ? "submitted" : "rejected";
    }
    return "accepted";
  }
  if (finality === "REJECTED") return "rejected";
  return "submitted";
}

/** @public */
export function readBlockNumber(receipt: unknown): number | null {
  if (!receipt || typeof receipt !== "object") return null;
  const r = receipt as { block_number?: number; blockNumber?: number };
  if (typeof r.block_number === "number") return r.block_number;
  if (typeof r.blockNumber === "number") return r.blockNumber;
  return null;
}
