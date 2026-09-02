import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { starknetBalance } from "../src/skills/starknet-balance.js";
import { makeCtx } from "./skills-helpers.js";

describe("skill starknet_balance", () => {
  beforeEach(() => {
    delete process.env.STARKNET_RPC_URL;
  });
  afterEach(() => {
    delete process.env.STARKNET_RPC_URL;
  });

  it("rejects malformed address via Zod", () => {
    expect(() => starknetBalance.inputSchema.parse({ address: "0xZZZZ" })).toThrow(ZodError);
  });

  it("isReplay=true → no RPC call (returns sentinel)", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await starknetBalance.execute({ address: "0xabc", token: "STRK" }, ctx);
    expect(out.balance_wei).toBe("0");
    expect(out.token).toBe("STRK");
  });

  it("throws when RPC URL missing", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(
      starknetBalance.execute({ address: "0xabc", token: "STRK" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });

  it("accepts valid full hex address", () => {
    expect(() =>
      starknetBalance.inputSchema.parse({
        address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
        token: "STRK",
      }),
    ).not.toThrow();
  });

  it("defaults token to STRK when omitted", () => {
    const result = starknetBalance.inputSchema.parse({ address: "0xabc" });
    expect(result.token).toBe("STRK");
  });

  it("uses dryRunMock when provided in replay mode", async () => {
    const mockResult = {
      address: "0xabc",
      token: "ETH" as const,
      balance_wei: "1000000000",
    };
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: { starknet_balance: () => mockResult },
    });
    const out = await starknetBalance.execute({ address: "0xabc", token: "ETH" }, ctx);
    expect(out.balance_wei).toBe("1000000000");
  });

  it("rejects token outside enum", () => {
    expect(() =>
      starknetBalance.inputSchema.parse({
        address: "0xabc",
        token: "BTC",
      }),
    ).toThrow(ZodError);
  });
});
