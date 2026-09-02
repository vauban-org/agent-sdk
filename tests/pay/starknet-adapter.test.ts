/**
 * Tests for StarknetSepoliaPayAdapter.
 *
 * Coverage : 11 cases across validation, happy path, secret discipline,
 * receipt classification, explorer URL, SaaS RPC rejection, and
 * `waitForAcceptance`. The starknet `RpcProvider` and `Account` classes are
 * replaced by `providerFactory` + `accountFactory` constructor overrides so
 * the tests stay offline.
 */

import type { Account, RpcProvider } from "starknet";
import { describe, expect, it, vi } from "vitest";
import type { PayRequest } from "../../src/pay/port.js";
import {
  DEFAULT_SEPOLIA_RPC_URL,
  SEPOLIA_EXPLORER_BASE,
  STRK_SEPOLIA_CONTRACT,
  StarknetSepoliaPayAdapter,
  classifyReceipt,
  readBlockNumber,
} from "../../src/pay/starknet-adapter.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const VALID_TO = `0x${"a".repeat(63)}`;
const VALID_SENDER = `0x${"b".repeat(63)}`;
const FAKE_PRIVATE_KEY = "0x1"; // bench-only key, never used against a real RPC.
const FAKE_TX = `0x${"c".repeat(63)}`;

function baseReq(overrides: Partial<PayRequest> = {}): PayRequest {
  return {
    to: VALID_TO,
    amount: 10n ** 18n,
    token: "STRK",
    network: "sepolia",
    senderAddress: VALID_SENDER,
    senderPrivateKey: FAKE_PRIVATE_KEY,
    ...overrides,
  };
}

interface MockedAccount {
  execute: ReturnType<typeof vi.fn>;
}
interface MockedProvider {
  getTransactionReceipt: ReturnType<typeof vi.fn>;
}

function buildAdapter(
  accountExecute: MockedAccount["execute"],
  providerReceipt: MockedProvider["getTransactionReceipt"],
  init: { rpcUrl?: string } = {},
): StarknetSepoliaPayAdapter {
  const provider: MockedProvider = {
    getTransactionReceipt: providerReceipt,
  };
  const account: MockedAccount = { execute: accountExecute };
  const opts: ConstructorParameters<typeof StarknetSepoliaPayAdapter>[0] = {
    providerFactory: () => provider as unknown as RpcProvider,
    accountFactory: () => account as unknown as Account,
    pollIntervalMs: 1,
  };
  if (init.rpcUrl !== undefined) opts.rpcUrl = init.rpcUrl;
  return new StarknetSepoliaPayAdapter(opts);
}

// ─── pay() : happy path ────────────────────────────────────────────────────────

describe("StarknetSepoliaPayAdapter.pay — happy path", () => {
  it("submits, returns accepted result with explorer URL + block number", async () => {
    const execute = vi.fn().mockResolvedValue({ transaction_hash: FAKE_TX });
    const getReceipt = vi.fn().mockResolvedValue({
      finality_status: "ACCEPTED_ON_L2",
      execution_status: "SUCCEEDED",
      block_number: 12345,
    });
    const adapter = buildAdapter(execute, getReceipt);

    const result = await adapter.pay(baseReq());
    expect(execute).toHaveBeenCalledTimes(1);
    const callArg = execute.mock.calls[0]?.[0] as {
      contractAddress: string;
      entrypoint: string;
      calldata: string[];
    };
    expect(callArg.contractAddress).toBe(STRK_SEPOLIA_CONTRACT);
    expect(callArg.entrypoint).toBe("transfer");
    // u256 split : 10^18 fits in low limb, high limb = "0"
    expect(callArg.calldata).toEqual([VALID_TO, (10n ** 18n).toString(10), "0"]);

    expect(result.txHash).toBe(FAKE_TX);
    expect(result.status).toBe("accepted");
    expect(result.blockNumber).toBe(12345);
    expect(result.explorerUrl).toBe(`${SEPOLIA_EXPLORER_BASE}/${FAKE_TX}`);
  });

  it("u256 split handles amounts larger than 2^128", async () => {
    const big = (1n << 130n) + 7n; // forces high limb > 0
    const execute = vi.fn().mockResolvedValue({ transaction_hash: FAKE_TX });
    const getReceipt = vi.fn().mockResolvedValue({
      finality_status: "ACCEPTED_ON_L2",
      execution_status: "SUCCEEDED",
    });
    const adapter = buildAdapter(execute, getReceipt);

    await adapter.pay(baseReq({ amount: big }));
    const calldata = (execute.mock.calls[0]?.[0] as { calldata: string[] }).calldata;
    const MASK = (1n << 128n) - 1n;
    expect(calldata[1]).toBe((big & MASK).toString(10));
    expect(calldata[2]).toBe((big >> 128n).toString(10));
  });

  it("returns submitted (not accepted) when receipt poll throws", async () => {
    const execute = vi.fn().mockResolvedValue({ transaction_hash: FAKE_TX });
    const getReceipt = vi.fn().mockRejectedValue(new Error("not yet visible"));
    const adapter = buildAdapter(execute, getReceipt);
    const result = await adapter.pay(baseReq());
    expect(result.status).toBe("submitted");
    expect(result.blockNumber).toBeUndefined();
  });
});

// ─── pay() : validation gates ──────────────────────────────────────────────────

describe("StarknetSepoliaPayAdapter.pay — validation", () => {
  it("rejects mainnet at the adapter boundary", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ network: "mainnet" }))).rejects.toThrow(
      /only supports network="sepolia"/,
    );
  });

  it("rejects unknown tokens (e.g. ETH) at MVP", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ token: "ETH" }))).rejects.toThrow(
      /only supports token="STRK"/,
    );
  });

  it("rejects malformed recipient", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ to: "not-a-hex" }))).rejects.toThrow(
      /invalid recipient address/,
    );
  });

  it("rejects malformed sender address", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ senderAddress: "0xZZZZ" }))).rejects.toThrow(
      /invalid sender address/,
    );
  });

  it("rejects non-positive amount", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ amount: 0n }))).rejects.toThrow(
      /amount must be a positive bigint/,
    );
  });

  it("rejects missing senderPrivateKey without echoing it", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.pay(baseReq({ senderPrivateKey: "" }))).rejects.toThrow(/\[REDACTED\]/);
  });
});

// ─── Secret discipline ─────────────────────────────────────────────────────────

describe("StarknetSepoliaPayAdapter — Tier-1 secret discipline", () => {
  it("never includes senderPrivateKey in thrown error messages", async () => {
    // Force an error path AFTER private key validation by mocking execute to
    // return a malformed tx hash. The error message must not echo the key.
    const secret = "0xCAFEBABE_SUPER_SECRET";
    const execute = vi.fn().mockResolvedValue({ transaction_hash: "not-hex" });
    const adapter = buildAdapter(execute, vi.fn());
    let caught: unknown = null;
    try {
      await adapter.pay(baseReq({ senderPrivateKey: secret }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("CAFEBABE");
  });
});

// ─── SaaS RPC rejection ────────────────────────────────────────────────────────

describe("StarknetSepoliaPayAdapter — SaaS RPC rejection", () => {
  it("refuses Infura RPC at construction", () => {
    expect(
      () =>
        new StarknetSepoliaPayAdapter({
          rpcUrl: "https://starknet-sepolia.infura.io/v3/abc",
          providerFactory: () => ({}) as unknown as RpcProvider,
          accountFactory: () => ({}) as unknown as Account,
        }),
    ).toThrow(/rejects SaaS RPC/);
  });
  it("refuses Alchemy RPC at construction", () => {
    expect(
      () =>
        new StarknetSepoliaPayAdapter({
          rpcUrl: "https://starknet-sepolia.g.alchemy.com/v2/k",
          providerFactory: () => ({}) as unknown as RpcProvider,
          accountFactory: () => ({}) as unknown as Account,
        }),
    ).toThrow(/rejects SaaS RPC/);
  });
  it("refuses Blast RPC at construction", () => {
    expect(
      () =>
        new StarknetSepoliaPayAdapter({
          rpcUrl: "https://starknet-sepolia.public.blastapi.io",
          providerFactory: () => ({}) as unknown as RpcProvider,
          accountFactory: () => ({}) as unknown as Account,
        }),
    ).toThrow(/rejects SaaS RPC/);
  });
  it("accepts the self-hosted Pathfinder URL", () => {
    expect(
      () =>
        new StarknetSepoliaPayAdapter({
          providerFactory: () => ({}) as unknown as RpcProvider,
          accountFactory: () => ({}) as unknown as Account,
        }),
    ).not.toThrow();
  });
  it("DEFAULT_SEPOLIA_RPC_URL points at vauban-infrastructure", () => {
    expect(DEFAULT_SEPOLIA_RPC_URL).toBe("https://sepolia.rpc.vauban.tech/rpc/v0_10");
  });
});

// ─── Receipt classifiers ───────────────────────────────────────────────────────

describe("classifyReceipt", () => {
  it("ACCEPTED_ON_L2 + SUCCEEDED → accepted", () => {
    expect(
      classifyReceipt({
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "SUCCEEDED",
      }),
    ).toBe("accepted");
  });
  it("ACCEPTED_ON_L2 + REVERTED → rejected", () => {
    expect(
      classifyReceipt({
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "REVERTED",
      }),
    ).toBe("rejected");
  });
  it("REJECTED → rejected", () => {
    expect(classifyReceipt({ finality_status: "REJECTED" })).toBe("rejected");
  });
  it("RECEIVED → submitted", () => {
    expect(classifyReceipt({ finality_status: "RECEIVED" })).toBe("submitted");
  });
  it("uses isSuccess helper when present", () => {
    expect(classifyReceipt({ isSuccess: () => true })).toBe("accepted");
  });
  it("uses isRejected helper when present", () => {
    expect(classifyReceipt({ isRejected: () => true })).toBe("rejected");
  });
  it("null receipt → submitted", () => {
    expect(classifyReceipt(null)).toBe("submitted");
  });
});

describe("readBlockNumber", () => {
  it("reads block_number snake_case", () => {
    expect(readBlockNumber({ block_number: 42 })).toBe(42);
  });
  it("reads blockNumber camelCase", () => {
    expect(readBlockNumber({ blockNumber: 7 })).toBe(7);
  });
  it("missing → null", () => {
    expect(readBlockNumber({})).toBeNull();
  });
});

// ─── waitForAcceptance ─────────────────────────────────────────────────────────

describe("StarknetSepoliaPayAdapter.waitForAcceptance", () => {
  it("returns once receipt resolves to accepted", async () => {
    let calls = 0;
    const getReceipt = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 2) throw new Error("not yet visible");
      return {
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "SUCCEEDED",
        block_number: 99,
      };
    });
    const adapter = buildAdapter(vi.fn(), getReceipt);
    const result = await adapter.waitForAcceptance(FAKE_TX, { timeoutMs: 500 });
    expect(result.status).toBe("accepted");
    expect(result.blockNumber).toBe(99);
  });

  it("throws on timeout", async () => {
    const getReceipt = vi.fn().mockRejectedValue(new Error("not yet visible"));
    const adapter = buildAdapter(vi.fn(), getReceipt);
    await expect(adapter.waitForAcceptance(FAKE_TX, { timeoutMs: 30 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("rejects malformed txHash", async () => {
    const adapter = buildAdapter(vi.fn(), vi.fn());
    await expect(adapter.waitForAcceptance("not-hex", { timeoutMs: 30 })).rejects.toThrow(
      /invalid txHash/,
    );
  });
});
