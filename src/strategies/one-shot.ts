/**
 * One-shot strategy — single LLM call, no tools, no loop.
 *
 * Useful for trivial tasks (single question/answer, summarisation, classification)
 * where the orchestration overhead of a tool-calling strategy is wasteful.
 *
 * @public @experimental @since 2.0.0
 */

import type { AgentContext, AgentCycleResult, AgentStrategy, StrategyMessage } from "./types.js";

class OneShotStrategy implements AgentStrategy {
  readonly name = "one-shot" as const;

  async run(ctx: AgentContext): Promise<AgentCycleResult> {
    if (!ctx.llmFn) {
      return {
        finalMessage: "",
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: 0, out: 0 },
      };
    }

    const messages: StrategyMessage[] = [
      { role: "system", content: ctx.systemPrompt },
      { role: "user", content: ctx.task },
    ];

    const start = Date.now();
    try {
      const response = await ctx.llmFn(messages);

      try {
        await ctx.hooks?.onStep?.({
          cycleIndex: 0,
          phase: "execution",
          durationMs: Date.now() - start,
          runId: ctx.runId,
          strategy: this.name,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          model: response.model,
        });
      } catch (err) {
        ctx.logger.warn?.(
          { err: (err as Error)?.message ?? String(err) },
          "one-shot.onStep_failed",
        );
      }

      return {
        finalMessage: response.content,
        stopReason: "complete",
        stepCount: 1,
        tokensUsed: { in: response.tokensIn, out: response.tokensOut },
        model: response.model,
        provider: response.provider,
      };
    } catch (err) {
      ctx.logger.warn?.({ err: (err as Error)?.message ?? String(err) }, "one-shot.failed");
      return {
        finalMessage: "",
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: 0, out: 0 },
      };
    }
  }
}

/**
 * Factory for the one-shot strategy. Use this rather than instantiating
 * the class directly — the class is an implementation detail.
 *
 * @public @experimental @since 2.0.0
 */
export function createOneShotStrategy(): AgentStrategy {
  return new OneShotStrategy();
}
