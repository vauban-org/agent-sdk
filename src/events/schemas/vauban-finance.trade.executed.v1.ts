import { z } from "zod";

export const VaubanFinanceTradeExecutedV1 = z
  .object({
    symbol: z.string(),
    direction: z.enum(["long", "short", "hold"]),
    quantity: z.number(),
    conviction: z.number().min(0).max(1),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
