import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { starknetBalance } from "../src/skills/starknet-balance.js";
import { SkillNotConfiguredError } from "../src/skills/errors.js";
import { makeCtx } from "./skills-helpers.js";

describe("skill starknet_balance", () => {
  beforeEach(() => {
    delete process.env.STARKNET_RPC_URL;
  });
  afterEach(() => {
    delete process.env.STARKNET_RPC_URL;
  });

  it("rejects malformed address via Zod", () => {
    expect(() =>
      starknetBalance.inputSchema.parse({ address: "0xZZZZ" }),
    ).toThrow(ZodError);
  });

  it("isReplay=true → no RPC call (returns sentinel)", async () => {
    const ctx = makeCtx({ isReplay: true });
    const out = await starknetBalance.execute(
      { address: "0xabc", token: "STRK" },
      ctx,
    );
    expect(out.balance_wei).toBe("0");
    expect(out.token).toBe("STRK");
  });

  it("throws when RPC URL missing", async () => {
    const ctx = makeCtx({ isReplay: false });
    await expect(
      starknetBalance.execute({ address: "0xabc", token: "STRK" }, ctx),
    ).rejects.toBeInstanceOf(SkillNotConfiguredError);
  });
});
