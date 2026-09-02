import { z } from "zod";

export const IncidentSloBurnV1 = z
  .object({
    slo: z.string(),
    burnRate: z.number(),
    severity: z.enum(["low", "medium", "high", "critical"]),
  })
  .strict();
