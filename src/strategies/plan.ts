/**
 * Plan-then-Execute strategy — Phase 1 plan, Phase 2 execute, Phase 3 synthesize.
 *
 * Port of `preste/standalone-plan-loop.ts`. The LLM produces a structured plan
 * upfront, each step is executed (tool or LLM), then a final LLM call
 * synthesises results into a coherent answer.
 *
 * Ideal for long, structured tasks where upfront planning beats reactive loops.
 *
 * @public @experimental @since 2.0.0
 */

import type { AgentContext, AgentCycleResult, AgentStrategy, StrategyMessage } from "./types.js";

const PLAN_SYSTEM_PROMPT = `You are a planning agent. Given a task, generate a structured execution plan.
Return ONLY a JSON array of steps (no markdown, no explanation):
[
  {"id": 1, "description": "...", "tool": "tool_name", "tool_args": {...}},
  {"id": 2, "description": "...", "tool": "read_file", "tool_args": {"path": "..."}},
  {"id": 3, "description": "...", "tool": null}
]

Keep the plan concise: 2-8 steps. Each step must be actionable.`;

const SYNTHESIZE_SYSTEM_PROMPT = `You are a synthesis agent. Given an original task, the execution plan, and the results of each step,
provide a comprehensive, accurate final answer to the original task.
Synthesize all evidence. Be concise and direct.`;

interface PlanStep {
  id: number;
  description: string;
  tool?: string;
  tool_args?: Record<string, unknown>;
}

interface ExecutedStep extends PlanStep {
  result?: string;
  error?: string;
  skipped?: boolean;
}

/**
 * Parse LLM response into PlanStep[].
 *
 * Handles raw JSON array and JSON embedded in markdown code blocks. Returns
 * null if parsing fails — caller falls back to single-step plan.
 *
 * @public
 */
export function parsePlanFromText(text: string): PlanStep[] | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const arrayStart = stripped.indexOf("[");
  if (arrayStart === -1) return null;

  const candidate = stripped.slice(arrayStart);

  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return null;

    const steps: PlanStep[] = [];
    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as Record<string, unknown>).id !== "number" ||
        typeof (item as Record<string, unknown>).description !== "string"
      ) {
        return null;
      }
      const raw = item as Record<string, unknown>;
      const step: PlanStep = {
        id: raw.id as number,
        description: raw.description as string,
      };
      if (raw.tool && typeof raw.tool === "string") {
        step.tool = raw.tool;
      }
      if (raw.tool_args && typeof raw.tool_args === "object") {
        step.tool_args = raw.tool_args as Record<string, unknown>;
      }
      steps.push(step);
    }
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

class PlanStrategy implements AgentStrategy {
  readonly name = "plan" as const;

  async run(ctx: AgentContext): Promise<AgentCycleResult> {
    if (!ctx.llmFn) {
      return {
        finalMessage: "",
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: 0, out: 0 },
      };
    }

    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastModel = "";
    let lastProvider = "";
    let stoppedReason: AgentCycleResult["stopReason"] = "complete";

    // ── Phase 1: PLAN ──────────────────────────────────────────────────────
    let plan: PlanStep[];
    const planPhaseStart = Date.now();

    try {
      const planMessages: StrategyMessage[] = [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: ctx.task },
      ];
      const planResponse = await ctx.llmFn(planMessages);
      totalTokensIn += planResponse.tokensIn;
      totalTokensOut += planResponse.tokensOut;
      lastModel = planResponse.model;
      lastProvider = planResponse.provider;

      const parsed = parsePlanFromText(planResponse.content);
      if (parsed !== null) {
        plan = parsed.slice(0, ctx.maxSteps);
      } else {
        plan = [
          {
            id: 1,
            description: `Execute task directly: ${ctx.task.slice(0, 200)}`,
          },
        ];
      }

      try {
        await ctx.hooks?.onStep?.({
          cycleIndex: 0,
          phase: "decision",
          durationMs: Date.now() - planPhaseStart,
          runId: ctx.runId,
          strategy: this.name,
          tokensIn: planResponse.tokensIn,
          tokensOut: planResponse.tokensOut,
          model: planResponse.model,
        });
      } catch (hookErr) {
        ctx.logger.warn?.(
          { err: (hookErr as Error)?.message ?? String(hookErr) },
          "plan.onStep_failed",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        finalMessage: `Error during planning phase: ${msg}`,
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: totalTokensIn, out: totalTokensOut },
        model: lastModel,
        provider: lastProvider,
      };
    }

    try {
      ctx.hooks?.onPhaseComplete?.("plan", plan);
    } catch {
      // best-effort
    }

    // ── Phase 2: EXECUTE ───────────────────────────────────────────────────
    const executed: ExecutedStep[] = [];
    const stepResults: string[] = [];

    for (const step of plan) {
      if (ctx.signal?.aborted) {
        stoppedReason = "user_cancelled";
        break;
      }

      const executedStep: ExecutedStep = { ...step };
      const stepStart = Date.now();

      if (step.tool) {
        try {
          const toolResult = await ctx.tools.execute(step.tool, step.tool_args ?? {});
          let resultStr: string;
          if (toolResult.ok) {
            try {
              resultStr = JSON.stringify(toolResult.data);
            } catch {
              resultStr = "[non-serializable result]";
            }
            executedStep.result = resultStr;
          } else {
            executedStep.error = toolResult.error.message;
            resultStr = `Error: ${toolResult.error.message}`;
          }
          stepResults.push(`Step ${step.id} (${step.description}): ${resultStr.slice(0, 2000)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          executedStep.error = msg;
          stepResults.push(`Step ${step.id} (${step.description}): Error ; ${msg}`);
        }
      } else {
        // LLM-based step.
        const contextParts: string[] = [
          `Original task: ${ctx.task}`,
          `Current step: ${step.description}`,
        ];
        if (stepResults.length > 0) {
          contextParts.push(`Previous results:\n${stepResults.slice(-3).join("\n")}`);
        }

        const stepMessages: StrategyMessage[] = [
          {
            role: "system",
            content:
              ctx.systemPrompt ||
              "You are a helpful AI assistant. Complete the assigned step accurately.",
          },
          { role: "user", content: contextParts.join("\n\n") },
        ];

        try {
          const stepResponse = await ctx.llmFn(stepMessages);
          totalTokensIn += stepResponse.tokensIn;
          totalTokensOut += stepResponse.tokensOut;
          lastModel = stepResponse.model;
          lastProvider = stepResponse.provider;

          executedStep.result = stepResponse.content;
          stepResults.push(
            `Step ${step.id} (${step.description}): ${stepResponse.content.slice(0, 2000)}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          executedStep.error = msg;
          stepResults.push(`Step ${step.id} (${step.description}): LLM error ; ${msg}`);
          stoppedReason = "error";
        }
      }

      executed.push(executedStep);

      try {
        await ctx.hooks?.onStep?.({
          cycleIndex: step.id,
          phase: "execution",
          durationMs: Date.now() - stepStart,
          runId: ctx.runId,
          strategy: this.name,
          ...(lastModel ? { model: lastModel } : {}),
        });
      } catch (hookErr) {
        ctx.logger.warn?.(
          { err: (hookErr as Error)?.message ?? String(hookErr) },
          "plan.onStep_failed",
        );
      }
    }

    // ── Phase 3: SYNTHESIZE ────────────────────────────────────────────────
    let synthesis = "";
    const synthStart = Date.now();

    try {
      const planSummary = plan
        .map((s) => `  ${s.id}. ${s.description}${s.tool ? ` [tool: ${s.tool}]` : ""}`)
        .join("\n");
      const resultsSummary = stepResults.join("\n\n");

      const synthesizeMessages: StrategyMessage[] = [
        { role: "system", content: SYNTHESIZE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Original task: ${ctx.task}`,
            "",
            "Execution plan:",
            planSummary,
            "",
            "Step results:",
            resultsSummary,
            "",
            "Synthesize the results and provide a comprehensive answer to the original task.",
          ].join("\n"),
        },
      ];

      const synthResponse = await ctx.llmFn(synthesizeMessages);
      totalTokensIn += synthResponse.tokensIn;
      totalTokensOut += synthResponse.tokensOut;
      lastModel = synthResponse.model;
      lastProvider = synthResponse.provider;
      synthesis = synthResponse.content;

      try {
        await ctx.hooks?.onStep?.({
          cycleIndex: plan.length + 1,
          phase: "feedback",
          durationMs: Date.now() - synthStart,
          runId: ctx.runId,
          strategy: this.name,
          tokensIn: synthResponse.tokensIn,
          tokensOut: synthResponse.tokensOut,
          model: synthResponse.model,
        });
      } catch (hookErr) {
        ctx.logger.warn?.(
          { err: (hookErr as Error)?.message ?? String(hookErr) },
          "plan.onStep_failed",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      synthesis =
        stepResults.length > 0
          ? `Synthesis failed (${msg}). Step results:\n${stepResults.join("\n\n")}`
          : `No results to synthesize. Error: ${msg}`;
      if (stoppedReason !== "error" && stoppedReason !== "user_cancelled") {
        stoppedReason = "error";
      }
    }

    return {
      finalMessage: synthesis,
      stopReason: stoppedReason,
      stepCount: executed.length,
      tokensUsed: { in: totalTokensIn, out: totalTokensOut },
      stepsTrace: executed,
      model: lastModel,
      provider: lastProvider,
    };
  }
}

/**
 * Factory for the Plan-then-Execute strategy.
 *
 * @public @experimental @since 2.0.0
 */
export function createPlanStrategy(): AgentStrategy {
  return new PlanStrategy();
}
