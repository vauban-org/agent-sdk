import { z } from "zod";

export const AgentHitlRequestedV1 = z
  .object({
    approvalId: z.string().uuid(),
    question: z.string(),
    deadline: z.string().datetime(),
  })
  .strict();
