/**
 * VoyagerDataOps — thin wrapper over Starknet JSON-RPC.
 *
 * Defaults to Vauban's self-hosted validator (no API key required), never a
 * third-party SaaS RPC. Rate-limited via configurable inter-call delay.
 * No indexed REST API — pure JSON-RPC v0.7.
 */

import { z } from "zod";

import { HttpError, fetchJson } from "../http/fetch-json.js";

const DEFAULT_RPC_URL = "https://rpc.vauban.tech/rpc/v0_10";
const DEFAULT_RATE_LIMIT_MS = 100;
const DEFAULT_CHUNK_SIZE = 1000;

/**
 * Reject third-party SaaS RPC URLs at construction time. Aligned with
 * `vauban-gouvernance/.claude/rules/architecture/starknet-rpc-self-hosted.md`
 * — every Starknet RPC call must go through rpc.vauban.tech /
 * sepolia.rpc.vauban.tech, never a SaaS provider.
 */
function rejectSaasRpc(url: string): void {
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
    "nethermind.io",
  ];
  const lc = url.toLowerCase();
  const hit = banned.find((b) => lc.includes(b));
  if (hit) {
    throw new Error(
      `VoyagerDataOps rejects SaaS RPC "${hit}". Use https://rpc.vauban.tech/rpc/v0_10 (per ADR-ECO-031).`,
    );
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface VoyagerConfig {
  /** Starknet JSON-RPC endpoint URL. Defaults to the self-hosted Vauban validator. */
  rpcUrl?: string;
  /** Minimum ms between consecutive RPC calls. Default: 100ms. */
  rateLimitMs?: number;
  /** Max events per getEvents call. Default: 1000. */
  chunkSize?: number;
}

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface WalletEvent {
  walletAddress: string;
  txHash: string;
  blockNumber: number;
  eventData: string[];
}

export interface HealthCheckResult {
  blockNumber: number;
  latencyMs: number;
}

// ─── Zod schemas (strict boundary validation) ────────────────────────────────

const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const EventSchema = z.object({
  transaction_hash: z.string(),
  block_number: z.number(),
  keys: z.array(z.string()),
  data: z.array(z.string()),
});

const GetEventsResultSchema = z.object({
  events: z.array(EventSchema),
  continuation_token: z.string().optional(),
});

// ─── VoyagerDataOps ──────────────────────────────────────────────────────────

export class VoyagerDataOps {
  private readonly rpcUrl: string;
  private readonly rateLimitMs: number;
  private readonly chunkSize: number;
  private lastCallAt = 0;
  private requestId = 0;

  constructor(config: VoyagerConfig = {}) {
    this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URL;
    rejectSaasRpc(this.rpcUrl);
    this.rateLimitMs = config.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /**
   * Extract unique wallet addresses that interacted with a protocol contract.
   * Uses starknet_getEvents; the first element of event.data is the caller.
   *
   * @param contractAddress - Protocol contract (e.g. zkLend main contract)
   * @param eventSelector   - Event key selector (hex string, e.g. Deposit event)
   * @param limit           - Max wallets to return. Default: 100.
   */
  async getProtocolWallets(
    contractAddress: string,
    eventSelector: string,
    limit = 100,
  ): Promise<string[]> {
    const wallets = new Set<string>();
    let continuationToken: string | undefined;

    while (wallets.size < limit) {
      const result = await this.getEvents({
        address: contractAddress,
        keys: [[eventSelector]],
        chunk_size: Math.min(this.chunkSize, limit * 2),
        continuation_token: continuationToken,
      });

      for (const event of result.events) {
        const caller = event.data[0];
        if (caller) wallets.add(caller);
        if (wallets.size >= limit) break;
      }

      continuationToken = result.continuation_token;
      if (!continuationToken) break;
    }

    return Array.from(wallets).slice(0, limit);
  }

  /**
   * Get events emitted by a specific wallet address for a given contract.
   */
  async getWalletEvents(
    walletAddress: string,
    contractAddress: string,
    eventSelector: string,
  ): Promise<WalletEvent[]> {
    const result = await this.getEvents({
      address: contractAddress,
      keys: [[eventSelector]],
      chunk_size: this.chunkSize,
    });

    return result.events
      .filter((e) => e.data[0] === walletAddress)
      .map((e) => ({
        walletAddress,
        txHash: e.transaction_hash,
        blockNumber: e.block_number,
        eventData: e.data,
      }));
  }

  /**
   * Verify RPC connectivity and return current block number + latency.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const t0 = Date.now();
    const res = await this.rpcCall<number>("starknet_blockNumber", []);
    return { blockNumber: res, latencyMs: Date.now() - t0 };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async getEvents(params: {
    address: string;
    keys: string[][];
    chunk_size: number;
    continuation_token?: string;
  }): Promise<z.infer<typeof GetEventsResultSchema>> {
    const raw = await this.rpcCall<unknown>("starknet_getEvents", [params]);
    return GetEventsResultSchema.parse(raw);
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    await this.throttle();

    const id = ++this.requestId;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, id });

    let raw: unknown;
    try {
      raw = await fetchJson(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        throw new VoyagerRpcError(`HTTP ${err.status} from ${this.rpcUrl}`, err.status);
      }
      throw err;
    }

    const parsed = RpcResponseSchema.parse(raw);

    if (parsed.error) {
      throw new VoyagerRpcError(parsed.error.message, parsed.error.code);
    }

    return parsed.result as T;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCallAt;
    if (elapsed < this.rateLimitMs) {
      await sleep(this.rateLimitMs - elapsed);
    }
    this.lastCallAt = Date.now();
  }
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class VoyagerRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(`VoyagerRpcError(${code}): ${message}`);
    this.name = "VoyagerRpcError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
