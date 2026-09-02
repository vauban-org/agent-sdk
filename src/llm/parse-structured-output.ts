/**
 * parseStructuredOutput — robust JSON parser for LLM outputs.
 *
 * Promoted from forge/src/agents/shared/parse-llm-output.ts (Vague 1.B.5).
 * Extended with optional Zod schema validation and typed error on failure.
 *
 * LLMs occasionally wrap JSON in markdown code-fences or append trailing
 * commentary. This parser strips those artifacts, attempts JSON.parse, runs
 * optional Zod validation, then returns a fallback or throws on unrecoverable
 * parse errors.
 *
 * @public @since 0.18.0
 */

import type { ZodSchema } from "zod";

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by `parseStructuredOutput` when:
 * - JSON.parse fails AND no `fallback` is provided, OR
 * - Zod validation fails AND no `fallback` is provided.
 * @public
 */
export class ParseStructuredOutputError extends Error {
  /** The raw LLM string that could not be parsed (first 500 chars). */
  readonly raw: string;
  /** The underlying parse / validation error. */
  override readonly cause: unknown;

  constructor(message: string, raw: string, cause: unknown) {
    super(message);
    this.name = "ParseStructuredOutputError";
    this.raw = raw.slice(0, 500);
    this.cause = cause;
  }
}

// ─── Markdown fence stripping ─────────────────────────────────────────────────

/** Strip ```json ... ``` or ``` ... ``` fences and trim whitespace. */
function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** @public */
export interface ParseStructuredOutputOpts<T> {
  /**
   * Optional Zod schema for runtime validation after JSON.parse.
   * If validation fails and no `fallback` is provided,
   * `ParseStructuredOutputError` is thrown.
   */
  schema?: ZodSchema<T>;
  /**
   * Fallback value returned when JSON.parse or Zod validation fails.
   * When provided, the function never throws.
   */
  fallback?: T;
}

/**
 * Parse a raw LLM string into a typed value.
 *
 * Pipeline:
 * 1. Strip markdown ```json / ``` fences.
 * 2. `JSON.parse` the cleaned string.
 * 3. Optionally validate with a Zod schema.
 * 4. Return the value, or `fallback`, or throw `ParseStructuredOutputError`.
 *
 * @param raw   - Raw string produced by the LLM.
 * @param opts  - Optional Zod schema and/or fallback value.
 * @returns Parsed (and optionally validated) value of type `T`.
 * @throws {ParseStructuredOutputError} when parsing fails and no fallback is set.
 * @public
 */
export function parseStructuredOutput<T>(raw: string, opts?: ParseStructuredOutputOpts<T>): T {
  const cleaned = stripMarkdownFences(raw);

  // ── Step 1: JSON.parse ───────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    if (opts?.fallback !== undefined) {
      return opts.fallback;
    }
    throw new ParseStructuredOutputError(
      `Failed to JSON.parse LLM output: ${String(err)}`,
      raw,
      err,
    );
  }

  // ── Step 2: Optional Zod validation ─────────────────────────────────────────
  if (opts?.schema) {
    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
      if (opts.fallback !== undefined) {
        return opts.fallback;
      }
      throw new ParseStructuredOutputError(
        `Zod validation failed: ${result.error.message}`,
        raw,
        result.error,
      );
    }
    return result.data;
  }

  return parsed as T;
}
