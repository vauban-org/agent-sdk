import { z } from "zod";

export const GlacisIdentityVerifiedV1 = z
  .object({
    userId: z.string().uuid(),
    method: z.enum(["zk_passport", "zk_email", "world_id"]),
  })
  .strict();
