import { z } from "zod";

export const TenantBudgetExceededV1 = z
  .object({
    tenantId: z.string().uuid(),
    period: z.string(),
    amountUsd: z.number(),
    limitUsd: z.number(),
  })
  .strict();
