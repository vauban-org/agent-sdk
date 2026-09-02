import { z } from "zod";

export const BrainSkillExtractedV1 = z
  .object({
    skillId: z.string(),
    agentSource: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
