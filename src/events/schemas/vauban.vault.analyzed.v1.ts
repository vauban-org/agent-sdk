import { z } from "zod";

export const VaubanVaultAnalyzedV1 = z
  .object({
    vaultId: z.string(),
    tvlUsd: z.number(),
    anomalies: z.array(
      z.object({
        type: z.string(),
        severity: z.enum(["info", "warning", "error", "critical"]),
        metric: z.string(),
        current: z.union([z.string(), z.number()]),
        expected: z.union([z.string(), z.number()]),
        description: z.string(),
      }),
    ),
    overallSeverity: z.enum(["info", "warning", "error", "critical"]),
    timestamp: z.string(),
    schemaVersion: z.string(),
  })
  .strict();
