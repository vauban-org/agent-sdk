import { z } from "zod";

export const AgentStartedV1 = z
  .object({
    agentName: z.string(),
    runId: z.string().uuid(),
    inputs: z.unknown(),
    tenantId: z.string().uuid().optional(),
  })
  .strict();
