import { z } from "zod";

export const VaubanRebalancingCheckedV1 = z
  .object({
    portfolioId: z.string(),
    maxDrift: z.number(),
    alertLevel: z.enum(["none", "warning", "critical"]),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
