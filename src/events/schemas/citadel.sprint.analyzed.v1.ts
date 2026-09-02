import { z } from "zod";

const SprintInsightV1 = z
  .object({
    type: z.string(),
    severity: z.enum(["info", "warning", "error", "critical"]),
    metric: z.string(),
    description: z.string(),
  })
  .strict();

export const CitadelSprintAnalyzedV1 = z
  .object({
    sprintId: z.string(),
    healthScore: z.number().int().min(0).max(100),
    overallSeverity: z.enum(["info", "warning", "error", "critical"]),
    insights: z.array(SprintInsightV1),
    blockers: z.array(z.string()),
    recommendations: z.array(z.string()),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
