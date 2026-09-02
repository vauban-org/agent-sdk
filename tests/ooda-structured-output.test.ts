/**
 * tests/ooda-structured-output.test.ts
 *
 * Sprint-562: A5 — withStructuredOutput<T>() Zod retry validation.
 *
 * Audit goal: each Zod retry is visible in the messages[] thread, so an
 * auditor can replay the exact correction path the LLM took.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  StructuredOutputError,
  withStructuredOutput,
} from "../src/orchestration/ooda/structured-output.js";

// ── Shared schemas ───────────────────────────────────────────────────────────

const StringSchema = z.string();
const NumberSchema = z.number();
const ObjSchema = z.object({ name: z.string(), value: z.number() });

const TestSchema = z.object({
  category: z.enum(["travel", "software", "meals", "equipment", "other"]),
  flagged: z.boolean(),
  reasoning: z.string(),
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("withStructuredOutput — happy path", () => {
  it("valid JSON on first attempt: retries=0, parsed matches schema", async () => {
    const result = await withStructuredOutput({
      schema: TestSchema,
      fn: async () =>
        JSON.stringify({
          category: "travel",
          flagged: false,
          reasoning: "hotel",
        }),
    });
    expect(result.parsed.category).toBe("travel");
    expect(result.retries).toBe(0);
    expect(result.rawMessages).toHaveLength(1);
  });

  it("valid JSON number: parsed is a number", async () => {
    const fn = async () => JSON.stringify(42);
    const result = await withStructuredOutput({ schema: NumberSchema, fn });
    expect(result.parsed).toBe(42);
    expect(typeof result.parsed).toBe("number");
    expect(result.retries).toBe(0);
  });

  it("valid nested object: parsed matches schema", async () => {
    const payload = { name: "Alice", value: 7 };
    const result = await withStructuredOutput({
      schema: ObjSchema,
      fn: async () => JSON.stringify(payload),
    });
    expect(result.parsed).toEqual(payload);
    expect(result.retries).toBe(0);
  });

  it("rawMessages contains the assistant response", async () => {
    const raw = JSON.stringify("hi");
    const result = await withStructuredOutput({
      schema: StringSchema,
      fn: async () => raw,
    });
    const assistantMsg = result.rawMessages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.content).toBe(raw);
  });
});

// ── Retry on invalid JSON ────────────────────────────────────────────────────

describe("withStructuredOutput — retry on invalid JSON", () => {
  it("invalid JSON first attempt, valid on second: retries=1", async () => {
    let call = 0;
    const result = await withStructuredOutput({
      schema: StringSchema,
      fn: async () => {
        call++;
        return call === 1 ? "not-valid-json" : JSON.stringify("fixed");
      },
    });
    expect(result.parsed).toBe("fixed");
    expect(result.retries).toBe(1);
  });

  it("retries on non-JSON response, fix prompt injected into messages", async () => {
    let callCount = 0;
    const result = await withStructuredOutput({
      schema: TestSchema,
      fn: async () => {
        callCount++;
        if (callCount === 1) {
          return "not valid json at all";
        }
        return JSON.stringify({
          category: "software",
          flagged: false,
          reasoning: "IDE license",
        });
      },
    });
    expect(callCount).toBe(2);
    expect(result.parsed.category).toBe("software");
    // First fix prompt must mention JSON
    expect(result.rawMessages[1].content).toContain("not valid JSON");
  });

  it("after invalid JSON, fn is called again with extended messages", async () => {
    const fn = vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      if (fn.mock.calls.length === 1) return "not-valid-json";
      return JSON.stringify("ok");
    });
    await withStructuredOutput({ schema: StringSchema, fn });
    expect(fn).toHaveBeenCalledTimes(2);
    const secondCallMessages = fn.mock.calls[1][0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(secondCallMessages.length).toBeGreaterThan(0);
  });

  it("rawMessages after invalid JSON contains a user fix message mentioning json", async () => {
    let call = 0;
    const result = await withStructuredOutput({
      schema: StringSchema,
      fn: async () => {
        call++;
        return call === 1 ? "not-valid-json" : JSON.stringify("recovered");
      },
    });
    const userMsgs = result.rawMessages.filter((m) => m.role === "user");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(userMsgs[0].content.toLowerCase()).toMatch(/json/);
  });
});

// ── Retry on Zod validation failure ─────────────────────────────────────────

describe("withStructuredOutput — retry on Zod validation failure", () => {
  it("Zod failure injects correction and fn called again", async () => {
    let callCount = 0;
    const result = await withStructuredOutput({
      schema: TestSchema,
      fn: async () => {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({
            category: "invalid_category",
            flagged: false,
            reasoning: "test",
          });
        }
        return JSON.stringify({
          category: "travel",
          flagged: true,
          reasoning: "fixed",
        });
      },
    });
    expect(callCount).toBe(2);
    expect(result.retries).toBe(1);
    expect(result.parsed.category).toBe("travel");
    // Messages thread must contain the correction path
    expect(result.rawMessages).toHaveLength(3); // assistant + user fix + assistant
  });

  it("second attempt returns valid JSON after Zod failure: retries=1", async () => {
    let call = 0;
    const result = await withStructuredOutput({
      schema: ObjSchema,
      fn: async () => {
        call++;
        if (call === 1) return JSON.stringify({ name: 123, value: "oops" });
        return JSON.stringify({ name: "Valid", value: 1 });
      },
    });
    expect(result.retries).toBe(1);
  });

  it("correction message after Zod failure contains 'Zod validation' text", async () => {
    let call = 0;
    const result = await withStructuredOutput({
      schema: ObjSchema,
      fn: async () => {
        call++;
        if (call === 1) return JSON.stringify(999);
        return JSON.stringify({ name: "Fixed", value: 5 });
      },
    });
    const zodFixMsg = result.rawMessages.find(
      (m) => m.role === "user" && m.content.includes("Zod validation"),
    );
    expect(zodFixMsg).toBeDefined();
  });

  it("maxRetries=0: throws immediately on Zod failure without retry", async () => {
    const fn = vi.fn(async () => JSON.stringify({ bad: true }));
    await expect(withStructuredOutput({ schema: ObjSchema, fn, maxRetries: 0 })).rejects.toThrow(
      StructuredOutputError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── Max retries exceeded ─────────────────────────────────────────────────────

describe("withStructuredOutput — max retries exceeded", () => {
  it("throws StructuredOutputError after exhausting maxRetries on Zod failures", async () => {
    await expect(
      withStructuredOutput({
        schema: TestSchema,
        maxRetries: 1,
        fn: async () =>
          JSON.stringify({
            category: "invalid",
            flagged: "not_bool",
            reasoning: 123,
          }),
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it("defaults to maxRetries=2: fn called 3 times total on persistent failure", async () => {
    let calls = 0;
    try {
      await withStructuredOutput({
        schema: TestSchema,
        fn: async () => {
          calls++;
          return JSON.stringify({});
        },
      });
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredOutputError);
    }
    // 1 initial + 2 retries = 3 total
    expect(calls).toBe(3);
  });

  it("all attempts return invalid JSON: throws StructuredOutputError", async () => {
    await expect(
      withStructuredOutput({
        schema: StringSchema,
        fn: async () => "bad",
        maxRetries: 2,
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it("all attempts return valid JSON but wrong schema: throws StructuredOutputError", async () => {
    let call = 0;
    await expect(
      withStructuredOutput({
        schema: ObjSchema,
        fn: async () => {
          call++;
          return JSON.stringify(call);
        },
        maxRetries: 2,
      }),
    ).rejects.toThrow(StructuredOutputError);
  });

  it("StructuredOutputError.name === 'StructuredOutputError'", async () => {
    try {
      await withStructuredOutput({
        schema: ObjSchema,
        fn: async () => JSON.stringify("wrong-type"),
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as StructuredOutputError).name).toBe("StructuredOutputError");
    }
  });

  it("StructuredOutputError.zodError is defined", async () => {
    try {
      await withStructuredOutput({
        schema: ObjSchema,
        fn: async () => JSON.stringify("wrong-type"),
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as StructuredOutputError).zodError).toBeDefined();
    }
  });
});

// ── StructuredOutputError class ──────────────────────────────────────────────

describe("StructuredOutputError", () => {
  it("is instanceof Error", async () => {
    try {
      await withStructuredOutput({
        schema: ObjSchema,
        fn: async () => JSON.stringify("not-object"),
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("zodError.issues is an array", async () => {
    try {
      await withStructuredOutput({
        schema: ObjSchema,
        fn: async () => JSON.stringify("not-object"),
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      const soErr = err as StructuredOutputError;
      expect(Array.isArray(soErr.zodError.issues)).toBe(true);
    }
  });

  it("error message is informative (contains 'retries' or 'validation')", async () => {
    try {
      await withStructuredOutput({
        schema: ObjSchema,
        fn: async () => JSON.stringify(false),
        maxRetries: 0,
      });
      expect.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      expect(msg).toMatch(/retries|validation/);
    }
  });
});

// ── Message thread integrity ─────────────────────────────────────────────────

describe("withStructuredOutput — message thread integrity", () => {
  it("fn receives cumulative messages on retry (not just the last one)", async () => {
    const fn = vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      if (fn.mock.calls.length === 1) return "invalid";
      return JSON.stringify("ok");
    });
    await withStructuredOutput({ schema: StringSchema, fn });
    const secondCallMessages = fn.mock.calls[1][0].messages as Array<{
      role: string;
      content: string;
    }>;
    // Should contain: assistant(invalid) + user(fix)
    expect(secondCallMessages.length).toBe(2);
  });

  it("never mutates input messages — each retry appends to a copy", async () => {
    const originalMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a classifier." },
    ];

    let firstCall = true;
    const result = await withStructuredOutput({
      schema: TestSchema,
      fn: async (_input) => {
        // The external originalMessages array must never be modified
        expect(originalMessages).toHaveLength(1);
        if (firstCall) {
          firstCall = false;
          return JSON.stringify({
            category: "invalid",
            flagged: false,
            reasoning: "bad",
          });
        }
        return JSON.stringify({
          category: "meals",
          flagged: false,
          reasoning: "lunch",
        });
      },
    });
    expect(result.retries).toBe(1);
    expect(originalMessages).toHaveLength(1);
  });

  it("each retry appends assistant response + user correction to messages", async () => {
    let capturedThirdCallMessages: Array<{ role: string; content: string }> = [];
    let callNum = 0;
    const fn = vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      callNum++;
      if (callNum === 3) {
        capturedThirdCallMessages = [...input.messages];
      }
      if (callNum <= 2) return "not-json";
      return JSON.stringify("recovered");
    });
    await withStructuredOutput({ schema: StringSchema, fn, maxRetries: 3 });
    // After 2 failures: [asst(bad1), user(fix), asst(bad2), user(fix)] = 4 messages
    expect(capturedThirdCallMessages.length).toBe(4);
  });

  it("fn receives empty messages array on first attempt", async () => {
    const fn = vi.fn(async (input: { messages: Array<{ role: string; content: string }> }) => {
      return JSON.stringify("first");
    });
    await withStructuredOutput({ schema: StringSchema, fn });
    expect(fn.mock.calls[0][0].messages).toEqual([]);
  });

  it("rawMessages grows by 2 per failed attempt (assistant + user correction)", async () => {
    let call = 0;
    const result = await withStructuredOutput({
      schema: StringSchema,
      fn: async () => {
        call++;
        if (call <= 2) return "bad";
        return JSON.stringify("good");
      },
      maxRetries: 3,
    });
    // 2 failed attempts (bad1, bad2) → 4 messages, then 1 success → total 5
    expect(result.rawMessages.length).toBe(5);
  });
});
