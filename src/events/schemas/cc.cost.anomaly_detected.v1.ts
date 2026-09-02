import { z } from "zod";

export const CcCostAnomalyDetectedV1 = z
  .object({
    agent: z.string(),
    expected: z.number(),
    actual: z.number(),
    period: z.string(),
  })
  .strict();
