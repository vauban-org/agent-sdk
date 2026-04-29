/**
 * hitl_request — programmatic HITL trigger.
 *
 * INSERTs a row into hitl_approvals (status='pending') and returns its id.
 * The agent then awaits resolution via the hitl-gate from quick-2 (separate
 * concern; this skill is fire-and-return-id).
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    agent_run_id: z.string().uuid(),
    reason: z.string().min(1).max(4_000),
    risk_level: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    payload: z.record(z.string(), z.unknown()).optional(),
    timeout_seconds: z.number().int().min(1).max(86_400).default(900),
  })
  .strict();
type HitlRequestInput = z.infer<typeof inputSchema>;

export interface HitlRequestOutput {
  id: string;
  status: "pending" | "replay";
  expires_at: string;
}

export const hitlRequest: Skill<HitlRequestInput, HitlRequestOutput> = {
  name: "hitl_request",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<HitlRequestOutput> {
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["hitl_request"];
      if (mock) return mock(input) as HitlRequestOutput;
      return {
        id: "00000000-0000-0000-0000-000000000000",
        status: "replay",
        expires_at: new Date(0).toISOString(),
      };
    }
    return withSkillSpan("hitl_request", async () => {
      const expiresAt = new Date(
        Date.now() + input.timeout_seconds * 1000,
      ).toISOString();
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO hitl_approvals
          (agent_run_id, reason, risk_level, payload, status, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', $5)
         RETURNING id`,
        [
          input.agent_run_id,
          input.reason,
          input.risk_level,
          JSON.stringify(input.payload ?? {}),
          expiresAt,
        ],
      );
      const id = rows[0]?.id;
      if (!id) {
        throw new Error("hitl_request: INSERT returned no id");
      }
      return { id, status: "pending", expires_at: expiresAt };
    });
  },
};
