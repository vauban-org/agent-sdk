/**
 * ReactLoop — Reason + Act tool-calling loop for the act phase.
 *
 * Thought → Action → Observation loop with maxStep guard. Model-agnostic:
 * accepts an `LLMCompletionFn` that decouples from any specific provider.
 *
 * Used within the `act` phase of an OODA cycle when the agent needs multi-step
 * reasoning with tool calls (ReAct pattern).
 *
 * Loop stops on:
 *   - Final answer (no tool call in response)
 *   - maxSteps reached
 *   - LLM error
 *   - AbortSignal fired
 *
 * @public
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface ToolCall {
  /** Tool name. */
  tool: string;
  /** Tool arguments — arbitrary JSON-serializable value. */
  args: Record<string, unknown>;
}

/** @public */
export interface ReactStep {
  /** Step index (0-based). */
  index: number;
  /** The LLM's reasoning / thought before the tool call. */
  thought: string;
  /** The tool call extracted from the LLM response, if any. */
  action?: ToolCall;
  /** The result of executing the tool, if a tool was called. */
  observation?: string;
  /** Error message if the tool call failed. */
  error?: string;
}

/** @public */
export interface ReactResult {
  /** Final answer from the LLM. */
  answer: string;
  /** All steps taken during the loop. */
  steps: ReactStep[];
  /** Total steps executed. */
  totalSteps: number;
  /** Whether the loop was stopped by maxSteps. */
  truncated: boolean;
}

/**
 * LLM completion function — model-agnostic interface.
 *
 * Accepts a list of messages and returns the LLM's response text.
 * Tool calls are parsed from the response text (JSON blocks or structured
 * API tool calls — implementation decides).
 * @public
 */
export type LLMCompletionFn = (messages: ReactMessage[]) => Promise<LLMReactResponse>;

/** @public */
export interface ReactMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool call ID (for 'tool' role messages). */
  tool_call_id?: string;
  /** Tool name (for 'assistant' messages with tool calls). */
  name?: string;
}

/** @public */
export interface LLMReactResponse {
  /** The full response text. */
  content: string;
  /** Parsed tool calls, if any. */
  toolCalls?: ToolCall[];
  /** Whether this is a final answer (no tool calls). */
  isFinal: boolean;
}

/**
 * Per-iteration telemetry callback metadata.
 *
 * @since 1.7.0
 * @public
 */
export interface ReactStepMeta {
  /** Iteration index (mirrors `step.index`). */
  iteration: number;
  /** Wall-clock duration of the iteration in milliseconds. */
  durationMs: number;
  /** Caller-supplied correlation id from `ReactLoopOptions.loopId`. */
  loopId?: string;
}

/**
 * Minimal logger contract for swallowed onStep errors.
 *
 * @since 1.7.0
 * @public
 */
export interface ReactLoopLogger {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/** @public */
export interface ReactLoopOptions {
  /** Max steps before forced stop (default: 10). */
  maxSteps?: number;
  /** System prompt for the LLM. */
  systemPrompt: string;
  /** Initial user message / task description. */
  task: string;
  /** LLM completion function. */
  llm: LLMCompletionFn;
  /** Execute a tool call and return the result. */
  executeTool: (call: ToolCall) => Promise<string>;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** 10KB limit on parsed tool call JSON to prevent DoS. */
  maxToolCallSize?: number;
  /** Allowed tool names. Unlisted tools get an error feedback. */
  allowedTools?: string[];
  /**
   * Called after each iteration with the completed step + timing.
   * Fire-and-forget — errors caught + logged via opts.logger, never
   * propagate to the loop. Use this to emit ctx.insertStep telemetry.
   *
   * @since 1.7.0
   */
  onStep?: (step: ReactStep, meta: ReactStepMeta) => void | Promise<void>;
  /**
   * Optional correlation id propagated into `meta.loopId` of every
   * `onStep` call, so callers can correlate multiple reactLoops within
   * one OODA cycle.
   *
   * @since 1.7.0
   */
  loopId?: string;
  /**
   * Logger used when `onStep` throws / rejects. Defaults to no-op
   * (errors are silently swallowed).
   *
   * @since 1.7.0
   */
  logger?: ReactLoopLogger;
  /**
   * When `true`, the `finalize` action emitted by the LLM is treated as a
   * real tool : `executeTool({ tool: "finalize", args })` is invoked, and
   * the returned value becomes `result.answer`. Side-effects (logging,
   * validation, persistence) can hang off this tool implementation.
   *
   * When `false` (default, backward-compat), `isFinal: true` short-circuits
   * the loop without calling `executeTool` — the LLM's `content` is used
   * directly as the answer. This is the SDK 1.6 — 1.9 behaviour.
   *
   * If `isFinal: true` is set but no matching finalize tool call is found
   * in `toolCalls`, the loop falls back to the legacy short-circuit
   * (LLM `content` becomes the answer) and emits a `logger.warn`.
   *
   * Unlocks Brief #6 (forge LLM, 2026-05-17) : agents that want
   * `finalize` to be a real tool — e.g. attach metadata, log, or validate
   * the final answer via a tool implementation.
   *
   * @since 1.10.0
   */
  finalizeAsTool?: boolean;
  /**
   * Tool name treated as the finalize action when `finalizeAsTool` is
   * `true`. Allows callers who prefer `return_final`, `submit`, etc.
   *
   * Default: `"finalize"`.
   *
   * @since 1.10.0
   */
  finalizeToolName?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_TOOL_CALL_SIZE = 10_240; // 10KB

// ─── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Invoke the user-supplied `onStep` callback with try/catch. Errors are
 * logged via `opts.logger?.warn` and never propagate to the caller.
 *
 * Handles both sync void and async returns.
 */
async function safeOnStep(
  cb: NonNullable<ReactLoopOptions["onStep"]>,
  step: ReactStep,
  meta: ReactStepMeta,
  logger: ReactLoopLogger | undefined,
): Promise<void> {
  try {
    const ret = cb(step, meta);
    if (ret && typeof (ret as Promise<void>).then === "function") {
      await ret;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.("reactLoop.onStep threw — error swallowed", {
      iteration: meta.iteration,
      loopId: meta.loopId,
      error: message,
    });
  }
}

// ─── Loop ───────────────────────────────────────────────────────────────────────

/**
 * Run a ReAct (Reasoning + Acting) loop.
 *
 * ```
 * Thought → Action → Observation → Thought → ... → Final Answer
 * ```
 * @public
 */
export async function reactLoop(opts: ReactLoopOptions): Promise<ReactResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxToolCallSize = opts.maxToolCallSize ?? DEFAULT_MAX_TOOL_CALL_SIZE;
  const allowedTools = opts.allowedTools;

  const steps: ReactStep[] = [];
  const messages: ReactMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.task },
  ];

  const { onStep, loopId, logger } = opts;
  const finalizeAsTool = opts.finalizeAsTool === true;
  const finalizeToolName = opts.finalizeToolName ?? "finalize";

  /** Build telemetry meta for iteration `i`, given its start timestamp. */
  const buildMeta = (i: number, iterationStart: number): ReactStepMeta => ({
    iteration: i,
    durationMs: Date.now() - iterationStart,
    loopId,
  });

  for (let i = 0; i < maxSteps; i++) {
    if (opts.signal?.aborted) {
      // Aborted iteration — step is not finalized, onStep is NOT called.
      return { answer: "", steps, totalSteps: i, truncated: true };
    }

    const iterationStart = Date.now();

    // Thought → Action
    const response = await opts.llm(messages);

    // finalizeAsTool path : when isFinal AND a matching finalize tool
    // call is present, invoke executeTool and use its return value as
    // the answer. Allows side-effects (logging, validation, persistence)
    // to hang off finalization.
    const finalizeCall =
      finalizeAsTool && response.isFinal
        ? response.toolCalls?.find((c) => c.tool === finalizeToolName)
        : undefined;

    steps.push({
      index: i,
      thought: response.content,
      // Record the finalize tool call as the step's action when invoked
      // as a tool — otherwise mirror the legacy behaviour (first tool
      // call, if any).
      action: finalizeCall ?? response.toolCalls?.[0],
    });

    if (finalizeCall) {
      let answer = response.content;
      try {
        const observation = await opts.executeTool(finalizeCall);
        steps[i].observation = observation;
        answer = observation;
      } catch (err) {
        steps[i].error = err instanceof Error ? err.message : String(err);
        steps[i].observation = `Error executing tool "${finalizeCall.tool}": ${steps[i].error}`;
        if (onStep) {
          await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
        }
        // Match the loop's existing error semantics — propagate so the
        // caller learns finalization failed.
        throw err;
      }
      if (onStep) {
        await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
      }
      return {
        answer,
        steps,
        totalSteps: i + 1,
        truncated: false,
      };
    }

    // Final answer — no tool call (legacy short-circuit)
    if (response.isFinal || !response.toolCalls || response.toolCalls.length === 0) {
      // finalizeAsTool mode but the LLM emitted isFinal without a
      // matching finalize tool call — warn and fall back to the legacy
      // short-circuit so a misbehaving LLM does not crash the loop.
      if (finalizeAsTool && response.isFinal) {
        logger?.warn?.(
          "reactLoop.finalizeAsTool: isFinal=true but no matching finalize tool call — falling back to LLM content as answer",
          {
            iteration: i,
            loopId,
            expectedTool: finalizeToolName,
            toolCallsSeen: response.toolCalls?.map((c) => c.tool) ?? [],
          },
        );
      }
      if (onStep) {
        await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
      }
      return {
        answer: response.content,
        steps,
        totalSteps: i + 1,
        truncated: false,
      };
    }

    const toolCall = response.toolCalls[0];

    // Validate tool call size
    const toolJson = JSON.stringify(toolCall);
    if (toolJson.length > maxToolCallSize) {
      steps[i].error = `Tool call exceeds ${maxToolCallSize}B limit`;
      steps[i].observation =
        `Error: tool call too large (${toolJson.length}B > ${maxToolCallSize}B limit)`;
      messages.push(
        { role: "assistant", content: response.content, name: toolCall.tool },
        {
          role: "tool",
          // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
          content: steps[i].observation!,
          tool_call_id: `call_${i}`,
        },
      );
      if (onStep) {
        await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
      }
      continue;
    }

    // Check allowed tools
    if (allowedTools && !allowedTools.includes(toolCall.tool)) {
      steps[i].error = `Tool "${toolCall.tool}" not in allowed list`;
      steps[i].observation = `Error: tool "${
        toolCall.tool
      }" is not allowed. Available tools: ${allowedTools.join(", ")}`;
      messages.push(
        { role: "assistant", content: response.content, name: toolCall.tool },
        {
          role: "tool",
          // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
          content: steps[i].observation!,
          tool_call_id: `call_${i}`,
        },
      );
      if (onStep) {
        await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
      }
      continue;
    }

    // Observation — execute tool
    try {
      const observation = await opts.executeTool(toolCall);
      steps[i].observation = observation;
    } catch (err) {
      steps[i].error = err instanceof Error ? err.message : String(err);
      steps[i].observation = `Error executing tool "${toolCall.tool}": ${steps[i].error}`;
    }

    // Feed observation back into the conversation
    messages.push(
      { role: "assistant", content: response.content, name: toolCall.tool },
      {
        role: "tool",
        // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
        content: steps[i].observation!,
        tool_call_id: `call_${i}`,
      },
    );

    // Step is fully finalized (thought + action + observation/error).
    if (onStep) {
      await safeOnStep(onStep, steps[i], buildMeta(i, iterationStart), logger);
    }
  }

  // Truncated — max steps reached
  const lastStep = steps[steps.length - 1];
  return {
    answer: lastStep?.thought ?? "",
    steps,
    totalSteps: maxSteps,
    truncated: true,
  };
}
