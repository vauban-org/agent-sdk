import { z } from "zod";

export const ForgeLeadQualifiedV1 = z
  .object({
    leadId: z.string().uuid(),
    score: z.number().min(0).max(100),
    source: z.enum(["inbound", "outbound", "referral"]),
  })
  .strict();
