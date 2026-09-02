import { z } from "zod";

export const VaubanFinanceForecastGeneratedV1 = z
  .object({
    scenarioId: z.string(),
    successRate: z.number().min(0).max(1),
    paramVelocity: z.number(),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
