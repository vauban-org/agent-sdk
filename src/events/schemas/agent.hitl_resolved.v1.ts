import { z } from "zod";

export const AgentHitlResolvedV1 = z
  .object({
    approvalId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    by: z.string(),
  })
  .strict();
