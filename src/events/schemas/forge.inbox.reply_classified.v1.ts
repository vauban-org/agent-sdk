import { z } from "zod";

export const ForgeInboxReplyClassifiedV1 = z
  .object({
    uid: z.string(),
    from: z.string(),
    subject: z.string(),
    type: z.enum(["INTERESTED", "NOT_INTERESTED", "BOUNCE", "SPAM", "OTHER"]),
    priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
    signal: z.string(),
    nextAction: z.string(),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
