import { z } from "zod";

export const TenantProvisionedV1 = z
  .object({
    tenantId: z.string().uuid(),
    plan: z.enum(["starter", "team", "pro", "enterprise"]),
    virtualKey: z.string(),
  })
  .strict();
