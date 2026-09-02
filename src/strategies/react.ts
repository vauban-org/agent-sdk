/**
 * ReAct strategy — Thought → Action → Observe text protocol with JSON
 * fallback for models that emit JSON tool calls instead of the standard
 * ```tool_call``` block.
 *
 * Port of `preste/standalone-react-loop.ts` (commit `fcde10a` — fix-G JSON
 * fallback). Pure data-flow plug-in : invokes `ctx.llmFn` + `ctx.tools.execute`,
 * does NOT touch SDK ports.
 *
 * @public @experimental @since 2.0.0
 */

import type { ToolResult } from "../tools/types.js";
import type {
  AgentContext,
  AgentCycleResult,
  AgentStrategy,
  StrategyLLMResponse,
  StrategyMessage,
  StrategyToolCall,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent with access to tools. For each step:
1. THINK about what you need to do
2. If you need information or to perform an action, call a tool
3. Observe the result and decide next steps
4. When you have enough information, provide your FINAL ANSWER directly (no tool call)

Always reason step by step. Use tools when needed.`;

const TOOL_CALL_REGEX = /```tool_call\s*\n([\s\S]*?)\n```/;

function buildToolDescriptions(
  registry: AgentContext["tools"],
  allowedTools?: readonly string[],
): string {
  const defs = registry.listMCPDefinitions();
  const filtered = allowedTools ? defs.filter((d) => allowedTools.includes(d.name)) : defs;
  if (filtered.length === 0) return "";
  const lines = filtered.map(
    (d) =>
      `- ${d.name}: ${d.description}\n  Parameters: ${JSON.stringify(
        d.inputSchema.properties ?? {},
      )}`,
  );
  return `\n\nAvailable tools:\n${lines.join("\n")}\n\nTo call a tool, embed a JSON block in your response:\n\`\`\`tool_call\n{"name": "tool_name", "arguments": {...}}\n\`\`\``;
}

/**
 * Parse a tool call out of the standard ```tool_call``` text block.
 *
 * Returns null if no block is found, the JSON is malformed, or the shape
 * is invalid (missing name/arguments).
 *
 * @public
 */
export function parseReactToolCall(content: string): StrategyToolCall | null {
  const match = TOOL_CALL_REGEX.exec(content);
  if (!match?.[1] || match[1].length > 10_000) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).name !== "string" ||
      typeof (parsed as Record<string, unknown>).arguments !== "object" ||
      (parsed as Record<string, unknown>).arguments === null
    ) {
      return null;
    }
    return {
      id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: (parsed as Record<string, unknown>).name as string,
      arguments: (parsed as Record<string, unknown>).arguments as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function isValidToolCallShape(
  parsed: unknown,
): parsed is { name: string; arguments: Record<string, unknown> } {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  return typeof p.name === "string" && typeof p.arguments === "object" && p.arguments !== null;
}

/**
 * JSON-fallback parser for models that emit tool calls in non-standard
 * formats (DeepSeek-v4-flash, raw JSON, ```toolcall``` / ```json``` fences).
 *
 * @public
 */
export function tryParseJsonToolCallFallback(
  content: string,
): { name: string; arguments: Record<string, unknown> } | null {
  if (!content || content.length > 200_000) return null;

  const fencedMatch = /```(?:toolcall|json)\s*([\s\S]*?)```/i.exec(content);
  if (fencedMatch?.[1]) {
    const block = fencedMatch[1].trim();
    if (block.length <= 10_000) {
      try {
        const parsed = JSON.parse(block) as unknown;
        if (isValidToolCallShape(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
  }

  const firstBrace = content.indexOf("{");
  if (firstBrace !== -1) {
    const candidate = content.slice(firstBrace).trim();
    if (candidate.length <= 10_000) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isValidToolCallShape(parsed)) return parsed;
      } catch {
        // fall through
      }
    }
  }

  return null;
}

function extractThoughtBefore(content: string, jsonStart: number): string {
  return content.slice(0, jsonStart).trim();
}

class ReactStrategy implements AgentStrategy {
  readonly name = "react" as const;

  async run(ctx: AgentContext): Promise<AgentCycleResult> {
    if (!ctx.llmFn) {
      return {
        finalMessage: "",
        stopReason: "error",
        stepCount: 0,
        tokensUsed: { in: 0, out: 0 },
      };
    }

    const baseSystem = ctx.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const toolDescriptions = buildToolDescriptions(ctx.tools, ctx.allowedTools);
    const systemPrompt = `${baseSystem}${toolDescriptions}`;

    const messages: StrategyMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: ctx.task },
    ];

    const steps: unknown[] = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let lastModel = "";
    let lastProvider = "";
    let stoppedReason: AgentCycleResult["stopReason"] = "max_steps";
    let finalAnswer = "";

    for (let i = 0; i < ctx.maxSteps; i++) {
      if (ctx.signal?.aborted) {
        stoppedReason = "user_cancelled";
        break;
      }

      const iterStart = Date.now();
      let response: StrategyLLMResponse;
      try {
        response = await ctx.llmFn(messages);
      } catch (err) {
        ctx.logger.warn?.({ err: (err as Error)?.message ?? String(err) }, "react.llm_failed");
        steps.push({
          iteration: i + 1,
          thought: "",
          error: `LLM call failed: ${(err as Error)?.message ?? String(err)}`,
        });
        stoppedReason = "error";
        break;
      }

      totalTokensIn += response.tokensIn;
      totalTokensOut += response.tokensOut;
      lastModel = response.model;
      lastProvider = response.provider;

      const structuredCall = response.toolCalls?.[0];
      const parsedCall = structuredCall ? null : parseReactToolCall(response.content);

      let toolCall: StrategyToolCall | null = structuredCall ?? parsedCall ?? null;
      let fallbackThought: string | null = null;

      if (!toolCall) {
        const jsonFallback = tryParseJsonToolCallFallback(response.content);
        if (jsonFallback) {
          const fenceIdx = response.content.search(/```(?:toolcall|json)/i);
          const braceIdx = response.content.indexOf("{");
          const splitAt = fenceIdx !== -1 ? fenceIdx : braceIdx !== -1 ? braceIdx : 0;
          fallbackThought = extractThoughtBefore(response.content, splitAt) || "(implicit)";
          toolCall = {
            id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: jsonFallback.name,
            arguments: jsonFallback.arguments,
          };
        }
      }

      // No tool call → final answer.
      if (!toolCall) {
        steps.push({ iteration: i + 1, thought: response.content });
        messages.push({ role: "assistant", content: response.content });
        stoppedReason = "complete";
        finalAnswer = response.content;
        try {
          await ctx.hooks?.onStep?.({
            cycleIndex: i,
            phase: "execution",
            durationMs: Date.now() - iterStart,
            runId: ctx.runId,
            strategy: this.name,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            model: response.model,
          });
        } catch (hookErr) {
          ctx.logger.warn?.(
            { err: (hookErr as Error)?.message ?? String(hookErr) },
            "react.onStep_failed",
          );
        }
        break;
      }

      // Tool call branch.
      if (ctx.allowedTools && !ctx.allowedTools.includes(toolCall.name)) {
        const errMsg = `Tool "${toolCall.name}" not in allowed list`;
        steps.push({
          iteration: i + 1,
          thought: fallbackThought ?? response.content,
          action: { toolName: toolCall.name, args: toolCall.arguments },
          error: errMsg,
        });
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "tool",
          content: `Error: ${errMsg}`,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
        continue;
      }

      const toolResult: ToolResult = await ctx.tools.execute(toolCall.name, toolCall.arguments);
      let observation: string;
      try {
        observation = toolResult.ok
          ? (JSON.stringify(toolResult.data) ?? "null")
          : `Error: ${toolResult.error.message}`;
      } catch {
        observation = "[non-serializable result]";
      }

      const stepThought =
        fallbackThought ?? response.content.replace(/```tool_call\s*\n[\s\S]*?\n```/g, "").trim();

      steps.push({
        iteration: i + 1,
        thought: stepThought,
        action: { toolName: toolCall.name, args: toolCall.arguments },
        observation,
        error: toolResult.ok ? undefined : toolResult.error.message,
      });

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "tool",
        content: observation,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });

      try {
        await ctx.hooks?.onStep?.({
          cycleIndex: i,
          phase: "execution",
          durationMs: Date.now() - iterStart,
          runId: ctx.runId,
          strategy: this.name,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          model: response.model,
        });
      } catch (hookErr) {
        ctx.logger.warn?.(
          { err: (hookErr as Error)?.message ?? String(hookErr) },
          "react.onStep_failed",
        );
      }
    }

    if (stoppedReason === "max_steps") {
      const lastStep = steps.at(-1) as Record<string, unknown> | undefined;
      finalAnswer = `Reached max iterations (${ctx.maxSteps}). Last: ${
        (lastStep?.observation as string) ?? "none"
      }`;
    } else if (stoppedReason === "error") {
      const lastStep = steps.at(-1) as Record<string, unknown> | undefined;
      finalAnswer = `Error: ${(lastStep?.error as string) ?? "Unknown error"}`;
    }

    return {
      finalMessage: finalAnswer,
      stopReason: stoppedReason,
      stepCount: steps.length,
      tokensUsed: { in: totalTokensIn, out: totalTokensOut },
      stepsTrace: steps,
      model: lastModel,
      provider: lastProvider,
    };
  }
}

/**
 * Factory for the ReAct strategy.
 *
 * @public @experimental @since 2.0.0
 */
export function createReactStrategy(): AgentStrategy {
  return new ReactStrategy();
}
