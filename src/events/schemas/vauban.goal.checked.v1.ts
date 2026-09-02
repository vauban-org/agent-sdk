import { z } from "zod";

export const VaubanGoalCheckedV1 = z
  .object({
    goalId: z.string(),
    successRate: z.number(),
    alertLevel: z.enum(["none", "warning", "critical"]),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
