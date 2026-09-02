import { z } from "zod";

export const AgentCompletedV1 = z
  .object({
    agentName: z.string(),
    runId: z.string().uuid(),
    outputs: z.unknown(),
    durationMs: z.number().int().positive(),
    costUsd: z.number().nonnegative(),
  })
  .strict();
