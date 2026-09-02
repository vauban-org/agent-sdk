import { z } from "zod";

export const CitadelSprintClosedV1 = z
  .object({
    sprintId: z.string(),
    completed: z.number().int().nonnegative(),
    carryOver: z.number().int().nonnegative(),
  })
  .strict();
