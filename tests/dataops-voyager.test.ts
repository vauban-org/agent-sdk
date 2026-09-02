/**
 * tests/dataops-voyager.test.ts
 *
 * Sprint-579: dataops-wrappers — interface contract tests.
 * Uses fetch mock; no live network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarkscanDataOps } from "../src/dataops/starkscan.js";
import { VoyagerDataOps, VoyagerRpcError } from "../src/dataops/voyager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockRpcResponse(result: unknown, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockRpcError(code: number, message: string, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_EVENTS = {
  events: [
    {
      transaction_hash: "0xabc1",
      block_number: 100,
      keys: ["0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2"],
      data: ["0xwallet1", "0xtoken", "0x64"],
    },
    {
      transaction_hash: "0xabc2",
      block_number: 101,
      keys: ["0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2"],
      data: ["0xwallet2", "0xtoken", "0x32"],
    },
    {
      transaction_hash: "0xabc3",
      block_number: 102,
      keys: ["0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2"],
      data: ["0xwallet1", "0xtoken", "0x10"], // duplicate wallet
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoyagerDataOps", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("healthCheck", () => {
    it("returns blockNumber and latencyMs", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(650_000));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const result = await ops.healthCheck();

      expect(result.blockNumber).toBe(650_000);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("calls starknet_blockNumber method", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(1));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      await ops.healthCheck();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.method).toBe("starknet_blockNumber");
    });

    it("throws VoyagerRpcError on RPC error response", async () => {
      fetchMock
        .mockResolvedValueOnce(mockRpcError(-32600, "Invalid request"))
        .mockResolvedValueOnce(mockRpcError(-32600, "Invalid request"));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      await expect(ops.healthCheck()).rejects.toThrow(VoyagerRpcError);
      await expect(ops.healthCheck()).rejects.toThrow("Invalid request");
    });

    it("throws VoyagerRpcError on HTTP error", async () => {
      fetchMock.mockResolvedValue(new Response("", { status: 429 }));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      await expect(ops.healthCheck()).rejects.toThrow(VoyagerRpcError);
    });
  });

  describe("getProtocolWallets", () => {
    it("returns unique wallet addresses from events", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(SAMPLE_EVENTS));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const wallets = await ops.getProtocolWallets("0xcontract", "0xeventselector");

      expect(wallets).toContain("0xwallet1");
      expect(wallets).toContain("0xwallet2");
      // deduplication: wallet1 appears twice in events but once in output
      expect(wallets.filter((w) => w === "0xwallet1")).toHaveLength(1);
    });

    it("respects limit parameter", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(SAMPLE_EVENTS));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const wallets = await ops.getProtocolWallets("0xcontract", "0xevent", 1);

      expect(wallets).toHaveLength(1);
    });

    it("paginates via continuation_token", async () => {
      const page1 = {
        events: [{ transaction_hash: "0x1", block_number: 1, keys: [], data: ["0xA"] }],
        continuation_token: "tok42",
      };
      const page2 = {
        events: [{ transaction_hash: "0x2", block_number: 2, keys: [], data: ["0xB"] }],
      };
      fetchMock
        .mockResolvedValueOnce(mockRpcResponse(page1))
        .mockResolvedValueOnce(mockRpcResponse(page2));

      const ops = new VoyagerDataOps({ rateLimitMs: 0 });
      const wallets = await ops.getProtocolWallets("0xc", "0xe", 10);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(wallets).toContain("0xA");
      expect(wallets).toContain("0xB");
    });

    it("calls starknet_getEvents with correct contract + key filter", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse({ events: [] }));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      await ops.getProtocolWallets("0xcontract123", "0xselector456");

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.method).toBe("starknet_getEvents");
      expect(body.params[0].address).toBe("0xcontract123");
      expect(body.params[0].keys[0][0]).toBe("0xselector456");
    });
  });

  describe("getWalletEvents", () => {
    it("filters events for the target wallet", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(SAMPLE_EVENTS));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const events = await ops.getWalletEvents("0xwallet1", "0xcontract", "0xevent");

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.walletAddress === "0xwallet1")).toBe(true);
    });

    it("returns correct WalletEvent shape", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(SAMPLE_EVENTS));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const events = await ops.getWalletEvents("0xwallet2", "0xcontract", "0xevent");

      expect(events[0]).toMatchObject({
        walletAddress: "0xwallet2",
        txHash: "0xabc2",
        blockNumber: 101,
        eventData: expect.arrayContaining(["0xwallet2"]),
      });
    });

    it("returns empty array when wallet has no events", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse({ events: [] }));
      const ops = new VoyagerDataOps({ rateLimitMs: 0 });

      const events = await ops.getWalletEvents("0xnobody", "0xcontract", "0xevent");

      expect(events).toHaveLength(0);
    });
  });

  describe("rate limiting", () => {
    it("enforces minimum delay between calls", async () => {
      fetchMock.mockResolvedValueOnce(mockRpcResponse(1)).mockResolvedValueOnce(mockRpcResponse(2));

      const ops = new VoyagerDataOps({ rateLimitMs: 50 });
      const t0 = Date.now();
      await ops.healthCheck();
      await ops.healthCheck();
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeGreaterThanOrEqual(40); // allow 20% timing slack for CI
    });

    it("uses configurable RPC URL", async () => {
      fetchMock.mockResolvedValue(mockRpcResponse(1));
      const ops = new VoyagerDataOps({
        rpcUrl: "https://custom.rpc/",
        rateLimitMs: 0,
      });

      await ops.healthCheck();

      expect(fetchMock.mock.calls[0][0]).toBe("https://custom.rpc/");
    });
  });
});

describe("StarkscanDataOps", () => {
  it("is an alias for VoyagerDataOps", () => {
    const ops = new StarkscanDataOps({ rateLimitMs: 0 });
    expect(ops).toBeInstanceOf(StarkscanDataOps);
    // same shape: healthCheck, getProtocolWallets, getWalletEvents
    expect(typeof ops.healthCheck).toBe("function");
    expect(typeof ops.getProtocolWallets).toBe("function");
    expect(typeof ops.getWalletEvents).toBe("function");
  });
});
