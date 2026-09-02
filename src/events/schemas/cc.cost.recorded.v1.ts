import { z } from "zod";

export const CcCostRecordedV1 = z
  .object({
    agent: z.string(),
    costUsd: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
    model: z.string(),
    tenantId: z.string().uuid().optional(),
  })
  .strict();
