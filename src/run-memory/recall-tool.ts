import { z } from "zod";
import type { AgentTool } from "../tools/types.js";
import type { RunJournalPort } from "./types.js";

const RecallParams = z
  .object({
    query: z.string().min(2).optional(),
    steps: z.array(z.number().int().nonnegative()).min(1).max(20).optional(),
  })
  .strict()
  .refine((p) => p.query !== undefined || p.steps !== undefined, {
    message: "provide `query` or `steps`",
  });

const PER_STEP_CHAR_CAP = 4000;
const TOTAL_CHAR_CAP = 20_000;

/**
 * `recall` : re-read earlier steps of THIS run evicted from the context
 * window. Errors surface as informative tool RESULTS (the model continues;
 * a broken journal must never kill the run, spec §5).
 * @public @experimental
 */
export function createRecallTool(journal: RunJournalPort): AgentTool<typeof RecallParams> {
  return {
    name: "recall",
    description:
      "Re-read earlier steps of THIS run that were evicted from the context window. " +
      "Pass steps:[i,...] (indices from the compaction index) for exact steps, " +
      "or query:'...' for a lexical search over the run journal.",
    parameters: RecallParams,
    execute: async (params) => {
      try {
        const steps = params.steps
          ? (await Promise.all(params.steps.map((i) => journal.read({ from: i, to: i })))).flat()
          : await journal.search(params.query as string, { topK: 5 });
        if (steps.length === 0) return "recall: no matching journaled steps.";
        let total = 0;
        const parts: string[] = [];
        for (const s of steps) {
          const label = s.toolName ? `${s.role}:${s.toolName}` : s.role;
          let body = s.content;
          if (body.length > PER_STEP_CHAR_CAP) {
            body = `${body.slice(0, PER_STEP_CHAR_CAP)}\n[truncated]`;
          }
          const block = `[step ${s.stepIndex} ${label}]\n${body}`;
          if (total + block.length > TOTAL_CHAR_CAP) break;
          total += block.length;
          parts.push(block);
        }
        return parts.join("\n\n");
      } catch (err) {
        return `recall unavailable: ${(err as Error).message}`;
      }
    },
  };
}
