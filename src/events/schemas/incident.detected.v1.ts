import { z } from "zod";

export const IncidentDetectedV1 = z
  .object({
    source: z.string(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    summary: z.string(),
  })
  .strict();
