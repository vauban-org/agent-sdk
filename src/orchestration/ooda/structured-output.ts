/**
 * withStructuredOutput<T>() — Zod schema-enforced LLM output with auto-retry.
 *
 * Sprint-562: A5 — Structured Output
 *
 * Zod validation failures are injected into the messages[] thread so the LLM
 * sees its mistake and corrects it on the next attempt. TInput is NEVER mutated
 * (new messages are appended to a copy).
 *
 * The correction path is auditable via the returned `rawMessages` thread: every
 * attempt appends the assistant response, and every rejected attempt appends the
 * injected fix prompt (the parse/Zod error). This helper emits no TraceStep of its
 * own ; its `fn` is invoked without an OODAContext, so trace emission is the
 * caller's responsibility if a proof chain is required.
 */

import type { ZodError, ZodSchema } from "zod";
import type { OODAContext } from "./types.js";

/** @public */
export interface StructuredOutputOptions<T> {
  /** Zod schema to validate against. */
  schema: ZodSchema<T>;
  /** LLM call function that returns a raw string. */
  fn: (
    input: { messages: Array<{ role: string; content: string }> },
    ctx: OODAContext,
  ) => Promise<string>;
  /** Max Zod retries before throwing (default 2). */
  maxRetries?: number;
}

/** @public */
export interface StructuredOutputResult<T> {
  parsed: T;
  rawMessages: Array<{ role: string; content: string }>;
  retries: number;
}

/** @public */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly zodError: ZodError,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Calls an LLM with Zod schema enforcement. On Zod failure, injects the
 * error into the messages thread and retries. TInput messages are never
 * mutated — each retry appends to a copy.
 * @public
 */
export async function withStructuredOutput<T>(
  opts: StructuredOutputOptions<T>,
): Promise<StructuredOutputResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const rawMessages: Array<{ role: string; content: string }> = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const messages = [...rawMessages];
    const raw = await opts.fn({ messages }, undefined as unknown as OODAContext);
    rawMessages.push({ role: "assistant", content: raw });

    // Try to extract JSON from the response
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const fixPrompt =
        "Your previous response was not valid JSON. Please respond ONLY with a valid JSON object matching the schema.";
      rawMessages.push({ role: "user", content: fixPrompt });
      continue;
    }

    const result = opts.schema.safeParse(parsed);
    if (result.success) {
      return { parsed: result.data, rawMessages, retries: attempt };
    }

    if (attempt < maxRetries) {
      const fixPrompt = `Your response failed Zod validation:\n${result.error.message}\n\nPlease fix the errors and return a valid JSON object.`;
      rawMessages.push({ role: "user", content: fixPrompt });
    } else {
      throw new StructuredOutputError(
        `Structured output validation failed after ${maxRetries} retries`,
        result.error,
      );
    }
  }

  // Unreachable — but TypeScript needs it
  throw new StructuredOutputError(
    `Structured output exhausted ${maxRetries} retries`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { issues: [] } as any as ZodError,
  );
}
