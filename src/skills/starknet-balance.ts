/**
 * starknet_balance — read STRK / ETH / vault balance via starknet.js (peer dep).
 *
 * starknet.js stays peerDependency. We dynamic-import — if absent, throw
 * SkillNotConfiguredError. RPC URL via STARKNET_RPC_URL env.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError, SkillNotConfiguredError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{1,64}$/),
    token: z.enum(["STRK", "ETH", "VAULT"]).default("STRK"),
    /** Override token contract for "VAULT" or custom tokens. */
    contract: z
      .string()
      .regex(/^0x[0-9a-fA-F]{1,64}$/)
      .optional(),
  })
  .strict();
type StarknetBalanceInput = z.infer<typeof inputSchema>;

export interface StarknetBalanceOutput {
  address: string;
  token: "STRK" | "ETH" | "VAULT";
  /** Raw u256 as decimal string (avoid float64 — see core/security-boundaries). */
  balance_wei: string;
}

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

export const starknetBalance: Skill<
  StarknetBalanceInput,
  StarknetBalanceOutput
> = {
  name: "starknet_balance",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<StarknetBalanceOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["starknet_balance"];
      if (mock) return mock(input) as StarknetBalanceOutput;
      return {
        address: input.address,
        token: input.token,
        balance_wei: "0",
      };
    }
    return withSkillSpan("starknet_balance", async () => {
      const rpcUrl = process.env.STARKNET_RPC_URL;
      if (!rpcUrl) {
        throw new SkillNotConfiguredError("starknet_balance", [
          "STARKNET_RPC_URL",
        ]);
      }
      let starknet: typeof import("starknet");
      try {
        starknet = await import(/* @vite-ignore */ "starknet");
      } catch (_err) {
        throw new SkillNotConfiguredError("starknet_balance", [
          "starknet (peer dependency)",
        ]);
      }
      const provider = new starknet.RpcProvider({ nodeUrl: rpcUrl });
      const tokenContract =
        input.contract ??
        (input.token === "STRK"
          ? STRK
          : input.token === "ETH"
            ? ETH
            : undefined);
      if (!tokenContract) {
        throw new SkillExecutionError(
          "starknet_balance",
          "VAULT requires explicit `contract` override",
        );
      }
      try {
        const result = await provider.callContract({
          contractAddress: tokenContract,
          entrypoint: "balanceOf",
          calldata: [input.address],
        });
        // u256 returned as 2 felts (low, high). Combine.
        const low = BigInt(result[0] ?? "0");
        const high = BigInt(result[1] ?? "0");
        const total = low + (high << 128n);
        return {
          address: input.address,
          token: input.token,
          balance_wei: total.toString(),
        };
      } catch (err) {
        throw new SkillExecutionError("starknet_balance", "RPC error", {
          cause: err,
        });
      }
    });
  },
};
