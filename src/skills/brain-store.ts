/**
 * brain_store — wrapper of BrainPort.archiveKnowledge with mcp_call_hash propagation.
 *
 * Requires the host to attach a BrainPort to the SkillContext via the
 * extended `brain` field (added by host wiring; SDK does not depend on
 * a concrete client). When absent or in replay, returns null id.
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import type { BrainPort, BrainEntryInput } from "../ports/brain.js";
import { SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    content: z.string().min(1),
    category: z.string().optional(),
    tags: z.array(z.string()).max(16).optional(),
    author: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    mcp_call_hash: z.string().optional(),
  })
  .strict();
type BrainStoreInput = z.infer<typeof inputSchema>;

export interface BrainStoreOutput {
  id: string | null;
  archived: boolean;
}

/** Optional brain field on context; host wires it in. */
type CtxWithBrain = SkillContext & { brain?: BrainPort };

export const brainStore: Skill<BrainStoreInput, BrainStoreOutput> = {
  name: "brain_store",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<BrainStoreOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["brain_store"];
      if (mock) return mock(input) as BrainStoreOutput;
      return { id: null, archived: false };
    }
    return withSkillSpan("brain_store", async () => {
      const brain = (ctx as CtxWithBrain).brain;
      if (!brain) {
        throw new SkillExecutionError(
          "brain_store",
          "no BrainPort attached to context",
        );
      }
      const entry: BrainEntryInput = {
        content: input.content,
        category: input.category,
        tags: input.tags,
        author: input.author,
        confidence: input.confidence,
        metadata: {
          ...(input.metadata ?? {}),
          ...(input.mcp_call_hash ? { mcp_call_hash: input.mcp_call_hash } : {}),
        },
      };
      const created = await brain.archiveKnowledge(entry);
      return { id: created?.id ?? null, archived: created != null };
    });
  },
};
