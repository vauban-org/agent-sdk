/**
 * Tests for parseStructuredOutput (Vague 1.B.5).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ParseStructuredOutputError,
  parseStructuredOutput,
} from "../src/llm/parse-structured-output.js";

describe("parseStructuredOutput", () => {
  // ── Positive cases ──────────────────────────────────────────────────────────

  it("parses plain JSON string", () => {
    const result = parseStructuredOutput<{ answer: number }>('{"answer": 42}');
    expect(result.answer).toBe(42);
  });

  it("strips markdown ```json fences before parsing", () => {
    const raw = '```json\n{"value": "hello"}\n```';
    const result = parseStructuredOutput<{ value: string }>(raw);
    expect(result.value).toBe("hello");
  });

  it("strips plain ``` fences before parsing", () => {
    const raw = '```\n{"x": true}\n```';
    const result = parseStructuredOutput<{ x: boolean }>(raw);
    expect(result.x).toBe(true);
  });

  it("validates with Zod schema when provided and returns typed result", () => {
    const schema = z.object({ name: z.string(), score: z.number() });
    const result = parseStructuredOutput('{"name":"Alice","score":99}', {
      schema,
    });
    expect(result.name).toBe("Alice");
    expect(result.score).toBe(99);
  });

  // ── Fallback cases ──────────────────────────────────────────────────────────

  it("returns fallback when JSON.parse fails and fallback is provided", () => {
    const fallback = { answer: 0 };
    const result = parseStructuredOutput<{ answer: number }>("not json at all", {
      fallback,
    });
    expect(result).toBe(fallback);
  });

  it("returns fallback when Zod validation fails and fallback is provided", () => {
    const schema = z.object({ count: z.number() });
    const fallback = { count: -1 };
    // "count" is a string instead of number — fails Zod
    const result = parseStructuredOutput('{"count":"wrong"}', {
      schema,
      fallback,
    });
    expect(result).toBe(fallback);
  });

  // ── Error cases ─────────────────────────────────────────────────────────────

  it("throws ParseStructuredOutputError on JSON.parse failure without fallback", () => {
    expect(() => parseStructuredOutput("not json")).toThrow(ParseStructuredOutputError);
  });

  it("throws ParseStructuredOutputError on Zod validation failure without fallback", () => {
    const schema = z.object({ id: z.number() });
    expect(() => parseStructuredOutput('{"id":"not-a-number"}', { schema })).toThrow(
      ParseStructuredOutputError,
    );
  });

  it("ParseStructuredOutputError includes truncated raw string", () => {
    const raw = `definitely not json ${"x".repeat(600)}`;
    let caught: ParseStructuredOutputError | undefined;
    try {
      parseStructuredOutput(raw);
    } catch (err) {
      caught = err as ParseStructuredOutputError;
    }
    expect(caught).toBeInstanceOf(ParseStructuredOutputError);
    expect(caught!.raw.length).toBeLessThanOrEqual(500);
  });

  it("handles nested JSON object correctly", () => {
    const raw = '{"nested":{"deep":{"value":1}}}';
    const result = parseStructuredOutput<{
      nested: { deep: { value: number } };
    }>(raw);
    expect(result.nested.deep.value).toBe(1);
  });
});
