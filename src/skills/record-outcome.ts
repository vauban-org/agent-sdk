/**
 * record_outcome — helper for outcomeMapping. INSERTs an `outcomes` row.
 *
 * Looks up `is_pending_backfill` from outcomes.yaml at OUTCOMES_YAML_PATH
 * (defaults to false when path absent or outcome_type not declared).
 *
 * Distinct from `tracking/gen-ai.recordOutcome()` (OTel attribute helper).
 * Lives in skills/ because it's invoked from OODA Act phase as a Skill.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    agent_id: z.string().min(1).max(64),
    agent_run_id: z.string().uuid().nullable(),
    outcome_type: z.string().min(1).max(64),
    /** Signed integer cents. */
    value_cents: z.number().int(),
    currency: z.string().length(3).default("USD"),
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .default(() => new Date().toISOString()),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
type RecordOutcomeInput = z.infer<typeof inputSchema>;

export interface RecordOutcomeOutput {
  id: string;
  is_pending_backfill: boolean;
}

interface OutcomesYamlEntry {
  type: string;
  is_pending_backfill?: boolean;
}

let OUTCOMES_INDEX: Map<string, boolean> | null = null;

async function loadOutcomesIndex(): Promise<Map<string, boolean>> {
  if (OUTCOMES_INDEX) return OUTCOMES_INDEX;
  const path = process.env.OUTCOMES_YAML_PATH;
  if (!path) {
    OUTCOMES_INDEX = new Map();
    return OUTCOMES_INDEX;
  }
  try {
    const [fs, yaml] = await Promise.all([
      import("node:fs/promises"),
      import("yaml"),
    ]);
    const raw = await fs.readFile(path, "utf-8");
    const parsed = yaml.parse(raw) as
      | { outcomes?: OutcomesYamlEntry[] }
      | OutcomesYamlEntry[];
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed.outcomes ?? []);
    const m = new Map<string, boolean>();
    for (const e of entries) {
      m.set(e.type, e.is_pending_backfill === true);
    }
    OUTCOMES_INDEX = m;
    return OUTCOMES_INDEX;
  } catch (err) {
    throw new SkillExecutionError("record_outcome", "could not load outcomes.yaml", {
      cause: err,
    });
  }
}

/** Test helper. */
export function _resetOutcomesIndex(): void {
  OUTCOMES_INDEX = null;
}

export const recordOutcomeSkill: Skill<
  RecordOutcomeInput,
  RecordOutcomeOutput
> = {
  name: "record_outcome",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<RecordOutcomeOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["record_outcome"];
      if (mock) return mock(input) as RecordOutcomeOutput;
      return {
        id: "00000000-0000-0000-0000-000000000000",
        is_pending_backfill: false,
      };
    }
    return withSkillSpan("record_outcome", async () => {
      const idx = await loadOutcomesIndex();
      const isPending = idx.get(input.outcome_type) ?? false;
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO outcomes
          (agent_id, agent_run_id, outcome_type, value_cents, currency,
           occurred_at, is_pending_backfill, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         RETURNING id`,
        [
          input.agent_id,
          input.agent_run_id,
          input.outcome_type,
          input.value_cents,
          input.currency,
          input.occurred_at,
          isPending,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const id = rows[0]?.id;
      if (!id) {
        throw new Error("record_outcome: INSERT returned no id");
      }
      return { id, is_pending_backfill: isPending };
    });
  },
};
