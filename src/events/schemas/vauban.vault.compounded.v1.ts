import { z } from "zod";

export const VaubanVaultCompoundedV1 = z
  .object({
    vaultId: z.string(),
    compoundedAt: z.string(),
    rewardsUsd: z.number(),
    caller: z.string(),
    txHash: z.string().optional(),
    schemaVersion: z.string(),
  })
  .strict();
