import { z } from "zod";

export const VaubanVaultRebalancedV1 = z
  .object({
    vaultId: z.string(),
    txHash: z.string(),
  })
  .strict();
