import { z } from "zod";

export const VaubanVaultRebalanceProposedV1 = z
  .object({
    vaultId: z.string(),
    currentRatio: z.number(),
    targetRatio: z.number(),
  })
  .strict();
