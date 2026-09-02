import { z } from "zod";

export const ForgeOutreachSentV1 = z
  .object({
    leadId: z.string().uuid(),
    channel: z.enum(["email", "linkedin", "x", "telegram"]),
    content: z.string(),
  })
  .strict();
