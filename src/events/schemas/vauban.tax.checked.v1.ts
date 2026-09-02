import { z } from "zod";

export const VaubanTaxCheckedV1 = z
  .object({
    userId: z.string(),
    rulesTriggered: z.array(z.string()),
    alertLevel: z.enum(["none", "warning", "critical"]),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
