/**
 * Trajectory export — RLHF/DPO training data from agent traces.
 *
 * Sprint-563: B3 — exportTrajectory(runId, db, opts).
 *
 * Formats:
 *  - jsonl: one JSON object per line, auto-labeled (positive/negative/neutral)
 *  - openai-dpo: OpenAI-compatible DPO format with chosen/rejected pairs
 *
 * Auto-labeling: outcome.value_cents > 0 → positive, < 0 → negative, null → neutral.
 */

import type { DbClient } from "../tracking/agent-run-tracker.js";

/** @public */
export type TrajectoryFormat = "jsonl" | "openai-dpo";

/** @public */
export interface TrajectoryOptions {
  format: TrajectoryFormat;
  /** Minimum tokens to include a step (skip empty LLM calls). */
  minTokens?: number;
  /** Maximum steps to export (default 1000). */
  maxSteps?: number;
}

/** @public */
export interface TrajectoryStep {
  runId: string;
  stepIndex: number;
  phase: string;
  type: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  timestamp?: string;
  /** Auto-label: positive | negative | neutral */
  label: "positive" | "negative" | "neutral";
}

/** @public */
export interface TrajectoryExport {
  steps: TrajectoryStep[];
  totalCost: number;
  totalTokens: number;
  format: TrajectoryFormat;
}

/**
 * Fetch trace steps from a run and export as training trajectory.
 * Uses the db client to query run_step rows.
 * @public
 */
export async function exportTrajectory(
  runId: string,
  db: DbClient,
  opts: TrajectoryOptions = { format: "jsonl" },
): Promise<TrajectoryExport> {
  const maxSteps = opts.maxSteps ?? 1000;
  const minTokens = opts.minTokens ?? 0;

  // Query steps from DB
  const rows = await db.query?.(
    `SELECT step_index, phase, type, payload, model, provider,
            input_tokens, output_tokens, cost_usd, duration_ms,
            created_at, outcome_value_cents
     FROM run_step
     WHERE run_id = $1
     ORDER BY step_index
     LIMIT $2`,
    [runId, String(maxSteps)],
  );

  const steps: TrajectoryStep[] = [];

  if (rows?.rows) {
    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const inputTokens = Number(row.input_tokens ?? 0);
      const outputTokens = Number(row.output_tokens ?? 0);
      if (inputTokens + outputTokens < minTokens) continue;

      const valueCents = row.outcome_value_cents != null ? Number(row.outcome_value_cents) : null;

      steps.push({
        runId,
        stepIndex: Number(row.step_index ?? 0),
        phase: String(row.phase ?? "unknown"),
        type: String(row.type ?? "unknown"),
        input: tryParse(row.payload),
        output: tryParse(row.output),
        model: row.model ? String(row.model) : undefined,
        provider: row.provider ? String(row.provider) : undefined,
        inputTokens,
        outputTokens,
        costUsd: Number(row.cost_usd ?? 0),
        durationMs: Number(row.duration_ms ?? 0),
        timestamp: row.created_at ? String(row.created_at) : undefined,
        label: valueCents === null ? "neutral" : valueCents > 0 ? "positive" : "negative",
      });
    }
  }

  const totalCost = steps.reduce((s, st) => s + (st.costUsd ?? 0), 0);
  const totalTokens = steps.reduce(
    (s, st) => s + (st.inputTokens ?? 0) + (st.outputTokens ?? 0),
    0,
  );

  return { steps, totalCost, totalTokens, format: opts.format };
}

/**
 * Serialize a trajectory export to the requested format.
 * @public
 */
export function serializeTrajectory(exp: TrajectoryExport): string {
  if (exp.format === "jsonl") {
    return exp.steps.map((s) => JSON.stringify(s)).join("\n");
  }

  // openai-dpo: pair consecutive steps as chosen/rejected
  const pairs: Array<{ chosen: TrajectoryStep; rejected: TrajectoryStep }> = [];
  const positive = exp.steps.filter((s) => s.label === "positive");
  const negative = exp.steps.filter((s) => s.label === "negative");

  for (let i = 0; i < Math.min(positive.length, negative.length); i++) {
    pairs.push({ chosen: positive[i], rejected: negative[i] });
  }

  return pairs
    .map((p) =>
      JSON.stringify({
        chosen: formatDpoMessage(p.chosen),
        rejected: formatDpoMessage(p.rejected),
      }),
    )
    .join("\n");
}

function formatDpoMessage(step: TrajectoryStep): unknown {
  return {
    messages: [
      ...(step.input
        ? [
            {
              role: "user",
              content: typeof step.input === "string" ? step.input : JSON.stringify(step.input),
            },
          ]
        : []),
      ...(step.output
        ? [
            {
              role: "assistant",
              content: typeof step.output === "string" ? step.output : JSON.stringify(step.output),
            },
          ]
        : []),
    ],
    metadata: {
      model: step.model,
      cost_usd: step.costUsd,
      label: step.label,
    },
  };
}

function tryParse(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
