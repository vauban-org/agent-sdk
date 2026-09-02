import { z } from "zod";

export const AgentFailedV1 = z
  .object({
    agentName: z.string(),
    runId: z.string().uuid(),
    error: z.string(),
    retryCount: z.number().int().nonnegative(),
  })
  .strict();
