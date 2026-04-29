/**
 * brain_query — wrapper of BrainPort.queryKnowledge with hash propagation.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import type {
  BrainPort,
  BrainEntry,
  BrainQueryFilters,
} from "../ports/brain.js";
import { SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    query: z.string().min(1).max(512),
    category: z.string().optional(),
    tags: z.array(z.string()).max(16).optional(),
    limit: z.number().int().min(1).max(100).default(10),
    mcp_call_hash: z.string().optional(),
  })
  .strict();
type BrainQueryInput = z.infer<typeof inputSchema>;

export interface BrainQueryOutput {
  entries: BrainEntry[];
}

type CtxWithBrain = SkillContext & { brain?: BrainPort };

export const brainQuery: Skill<BrainQueryInput, BrainQueryOutput> = {
  name: "brain_query",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<BrainQueryOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["brain_query"];
      if (mock) return mock(input) as BrainQueryOutput;
      return { entries: [] };
    }
    return withSkillSpan("brain_query", async () => {
      const brain = (ctx as CtxWithBrain).brain;
      if (!brain || !brain.queryKnowledge) {
        throw new SkillExecutionError(
          "brain_query",
          "no BrainPort.queryKnowledge attached to context",
        );
      }
      const filters: BrainQueryFilters = {
        category: input.category,
        tags: input.tags,
        limit: input.limit,
      };
      if (input.mcp_call_hash) {
        filters.mcp_call_hash = input.mcp_call_hash;
      }
      const entries = await brain.queryKnowledge(input.query, filters);
      return { entries };
    });
  },
};
