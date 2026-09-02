/**
 * Conversation rewind — reconstruct a prefix of a Trace as an initialMessages
 * array suitable for `AgentLoopConfig.initialMessages`.
 *
 * Use case (T6b session time-travel & branch):
 *   `preste rewind --from <trace.json> --to-step N --then "<new task>"`
 *   starts a fresh run whose conversation begins with the original run's
 *   steps[0..N-1] (assistant outputs + tool results) and then receives a
 *   new user message.
 *
 * This is a "fork-style" replay — it does NOT attempt byte-identical
 * deterministic re-execution (see `src/replay/replay.ts` `replayFrom` for
 * that audit-grade path). It only reconstructs the message log so a new
 * autonomous run can take the same agent down a different branch.
 *
 * Policy gating:
 *   - "include" / "redact"  — `storedOutput` is present; replay possible.
 *   - "hmac" / "hash-only"  — payloads not stored; replay refused with a
 *                              `TraceReplayError` naming the offending step.
 *
 * Step type mapping:
 *   - llm_call          → assistant message (storedOutput rendered as text)
 *   - tool_call         → tool message (storedOutput rendered, toolName attached)
 *   - guard_check       → skipped (no conversation effect)
 *   - phase_transition  → skipped
 *   - hitl_gate         → skipped (handled by the loop's HITL machinery at runtime)
 *
 * @module trace/rewind
 */

import type { Trace } from "./schema.js";

/**
 * Thrown when a Trace prefix cannot be reconstructed — bad bounds or a
 * step whose payload policy redacts both input and output.
 * @public
 */
export class TraceReplayError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TraceReplayError";
  }
}

/**
 * A reconstructed message — shape-compatible with
 * `AgentLoopConfig.initialMessages[number]`.
 *
 * `user` appears only as the leading "original task" message when
 * `ReconstructOptions.originalUserMessage` is provided; the remaining
 * reconstructed messages are always `assistant` or `tool`.
 * @public
 */
export interface ReplayMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

/**
 * Options for `reconstructInitialMessages`.
 * @public
 */
export interface ReconstructOptions {
  /**
   * Number of steps from the start of the trace to replay.
   * 0 returns an empty array (or just the original user message if set).
   * Must be in `[0, trace.steps.length]`.
   */
  toStep: number;
  /**
   * Optional: the original user task string (typically `trace.config.task`).
   * When set, it is prepended as a `{ role: "user", content }` message so the
   * model sees the original framing before the reconstructed assistant /
   * tool turns. Empty / whitespace-only strings are ignored.
   */
  originalUserMessage?: string;
}

function stringifyStored(stored: unknown): string {
  if (typeof stored === "string") return stored;
  if (stored === undefined || stored === null) return "";
  try {
    return JSON.stringify(stored);
  } catch {
    return String(stored);
  }
}

/**
 * Reconstruct an `initialMessages` array from the first `toStep` steps
 * of a Trace. Bails early on policies that don't store payloads.
 * @public
 */
export function reconstructInitialMessages(
  trace: Trace,
  opts: ReconstructOptions,
): ReplayMessage[] {
  const { toStep } = opts;

  if (!Number.isInteger(toStep) || toStep < 0) {
    throw new TraceReplayError(`invalid toStep ${toStep}: must be a non-negative integer`);
  }
  if (toStep > trace.steps.length) {
    throw new TraceReplayError(
      `invalid toStep ${toStep}: trace has only ${trace.steps.length} steps`,
    );
  }
  const original = opts.originalUserMessage?.trim();
  const leadingUserMsg: ReplayMessage[] = original ? [{ role: "user", content: original }] : [];

  if (toStep === 0) return leadingUserMsg;

  const prefix = trace.steps.slice(0, toStep);

  // Pre-flight: refuse on any step whose policy redacts payloads.
  for (const step of prefix) {
    if (step.policy === "hmac" || step.policy === "hash-only") {
      throw new TraceReplayError(
        `cannot rewind: step ${step.index} has policy "${step.policy}" — payloads are not stored. Rewind requires "include" or "redact".`,
      );
    }
  }

  const messages: ReplayMessage[] = [...leadingUserMsg];
  for (const step of prefix) {
    if (step.type === "llm_call") {
      messages.push({
        role: "assistant",
        content: stringifyStored(step.storedOutput),
      });
    } else if (step.type === "tool_call") {
      messages.push({
        role: "tool",
        content: stringifyStored(step.storedOutput),
        ...(step.toolName ? { toolName: step.toolName } : {}),
      });
    }
    // guard_check / phase_transition / hitl_gate: skipped — no message effect.
  }

  return messages;
}
