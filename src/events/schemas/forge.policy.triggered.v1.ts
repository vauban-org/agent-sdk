import { z } from "zod";

export const ForgePolicyTriggeredV1 = z
  .object({
    policyId: z.string(),
    context: z.record(z.unknown()),
  })
  .strict();
