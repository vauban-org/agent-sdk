/**
 * buildOrientPrompt — generic OODA orient-phase prompt factory.
 *
 * Promoted from forge/src/agents/shared/orient-prompt.ts (Vague 1.B.5).
 * Forge-specific fields (agentId, agentRole, outputSchema) have been replaced
 * by generic opts so any SDK consumer can drive the orient phase.
 *
 * Hard cap: `userContext` is truncated to `maxContextChars` (default 2500)
 * to stay within per-turn token budgets on M/L tasks.
 *
 * @public @since 0.18.0
 */

const DEFAULT_MAX_CONTEXT_CHARS = 2500;
const TRUNCATION_MARKER = "[...truncated]";

/** @public */
export interface BuildOrientPromptOpts {
  /** System-level instructions for the LLM. */
  systemPrompt: string;
  /** User-facing context (observation, data, etc.) — capped to `maxContextChars`. */
  userContext: string;
  /**
   * JSON Schema object injected into the system prompt when present.
   * Tells the LLM which output shape is expected.
   */
  jsonSchema?: object;
  /** Recent memory entries prepended as a bullet list. */
  recentMemory?: string[];
  /**
   * Maximum characters for `userContext` before truncation.
   * @default 2500
   */
  maxContextChars?: number;
}

/**
 * Build the `{ system, user }` prompt pair for an OODA orient phase.
 *
 * The system prompt receives optional JSON Schema injection.
 * The user prompt is capped at `maxContextChars` with a truncation indicator.
 * @public
 */
export function buildOrientPrompt(opts: BuildOrientPromptOpts): {
  system: string;
  user: string;
} {
  const {
    systemPrompt,
    userContext,
    jsonSchema,
    recentMemory,
    maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
  } = opts;

  // ── System prompt ────────────────────────────────────────────────────────────
  const schemaBlock =
    jsonSchema !== undefined
      ? `\n\nOutput JSON schema:\n${JSON.stringify(jsonSchema, null, 2)}`
      : "";

  const system = `${systemPrompt}${schemaBlock}`;

  // ── User prompt ──────────────────────────────────────────────────────────────
  const memoryBlock =
    recentMemory && recentMemory.length > 0
      ? `Recent memory:\n${recentMemory.map((m) => `- ${m}`).join("\n")}`
      : "";

  // Truncate userContext if it exceeds the cap.
  const cappedContext =
    userContext.length > maxContextChars
      ? `${userContext.slice(0, maxContextChars)}${TRUNCATION_MARKER}`
      : userContext;

  const userParts = [memoryBlock, cappedContext].filter(Boolean);
  const user = userParts.join("\n\n");

  return { system, user };
}
