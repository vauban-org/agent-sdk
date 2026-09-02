/**
 * Tests for `reconstructInitialMessages` — Trace prefix → ReplayMessage[].
 * Covers nominal include, redact, hash-only/hmac bail, edge bounds, and the
 * llm_call/tool_call vs guard_check filtering rule.
 */

import { describe, expect, it } from "vitest";

import { TraceReplayError, reconstructInitialMessages } from "../src/trace/rewind.js";
import type { Trace, TraceStep } from "../src/trace/schema.js";

function makeStep(over: Partial<TraceStep>): TraceStep {
  return {
    index: 0,
    runId: "run-1",
    phase: "decide",
    type: "llm_call",
    timestamp: 1,
    durationMs: 1,
    inputHash: "ih",
    outputHash: "oh",
    policy: "include",
    prevStepHash: "p",
    stepHash: "s",
    ...over,
  };
}

function makeTrace(steps: TraceStep[]): Trace {
  return {
    schemaVersion: "1.0.0",
    runId: "run-1",
    agentId: "ASSISTANT",
    agentVersion: "3.1.0",
    startedAt: 0,
    completedAt: 0,
    status: "completed",
    steps,
    totalSteps: steps.length,
    rootHash: "rh",
    config: {},
    configHash: "ch",
  };
}

describe("reconstructInitialMessages", () => {
  it("returns [] when toStep is 0", () => {
    const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: "hi" })]);
    expect(reconstructInitialMessages(trace, { toStep: 0 })).toEqual([]);
  });

  describe("originalUserMessage", () => {
    it("prepends a user message before the reconstructed prefix", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: "ack" })]);
      const msgs = reconstructInitialMessages(trace, {
        toStep: 1,
        originalUserMessage: "Refactor module X",
      });
      expect(msgs).toEqual([
        { role: "user", content: "Refactor module X" },
        { role: "assistant", content: "ack" },
      ]);
    });

    it("emits only the user message when toStep is 0", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: "ack" })]);
      const msgs = reconstructInitialMessages(trace, {
        toStep: 0,
        originalUserMessage: "Refactor module X",
      });
      expect(msgs).toEqual([{ role: "user", content: "Refactor module X" }]);
    });

    it("ignores whitespace-only originalUserMessage", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: "ack" })]);
      const msgs = reconstructInitialMessages(trace, {
        toStep: 1,
        originalUserMessage: "   ",
      });
      expect(msgs).toEqual([{ role: "assistant", content: "ack" }]);
    });

    it("trims surrounding whitespace from the user message", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: "ack" })]);
      const msgs = reconstructInitialMessages(trace, {
        toStep: 1,
        originalUserMessage: "  Do the thing  \n",
      });
      expect(msgs[0]).toEqual({ role: "user", content: "Do the thing" });
    });
  });

  it("maps llm_call to assistant and tool_call to tool with toolName", () => {
    const trace = makeTrace([
      makeStep({ index: 0, type: "llm_call", storedOutput: "I will grep." }),
      makeStep({
        index: 1,
        type: "tool_call",
        toolName: "run_bash",
        storedOutput: { stdout: "found", exitCode: 0 },
      }),
      makeStep({
        index: 2,
        type: "llm_call",
        storedOutput: "Done.",
      }),
    ]);

    const msgs = reconstructInitialMessages(trace, { toStep: 3 });
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "assistant", content: "I will grep." });
    expect(msgs[1]).toEqual({
      role: "tool",
      content: JSON.stringify({ stdout: "found", exitCode: 0 }),
      toolName: "run_bash",
    });
    expect(msgs[2]).toEqual({ role: "assistant", content: "Done." });
  });

  it("works with redact policy (storedOutput still present)", () => {
    const trace = makeTrace([
      makeStep({
        index: 0,
        type: "llm_call",
        policy: "redact",
        storedOutput: "redacted view of assistant turn",
      }),
    ]);
    const msgs = reconstructInitialMessages(trace, { toStep: 1 });
    expect(msgs).toEqual([{ role: "assistant", content: "redacted view of assistant turn" }]);
  });

  it("skips guard_check, phase_transition, hitl_gate steps", () => {
    const trace = makeTrace([
      makeStep({ index: 0, type: "llm_call", storedOutput: "a" }),
      makeStep({ index: 1, type: "guard_check", guardName: "pii" }),
      makeStep({ index: 2, type: "phase_transition" }),
      makeStep({ index: 3, type: "hitl_gate", phase: "hitl" }),
      makeStep({
        index: 4,
        type: "tool_call",
        toolName: "fetch",
        storedOutput: "ok",
      }),
    ]);

    const msgs = reconstructInitialMessages(trace, { toStep: 5 });
    expect(msgs).toEqual([
      { role: "assistant", content: "a" },
      { role: "tool", content: "ok", toolName: "fetch" },
    ]);
  });

  it("clips to the requested prefix (toStep < steps.length)", () => {
    const trace = makeTrace([
      makeStep({ index: 0, type: "llm_call", storedOutput: "first" }),
      makeStep({ index: 1, type: "llm_call", storedOutput: "second" }),
      makeStep({ index: 2, type: "llm_call", storedOutput: "third" }),
    ]);
    const msgs = reconstructInitialMessages(trace, { toStep: 2 });
    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("omits toolName field when step has no toolName", () => {
    const trace = makeTrace([makeStep({ index: 0, type: "tool_call", storedOutput: "raw" })]);
    const msgs = reconstructInitialMessages(trace, { toStep: 1 });
    expect(msgs[0]).toEqual({ role: "tool", content: "raw" });
    expect("toolName" in (msgs[0] ?? {})).toBe(false);
  });

  it("renders deeply-nested tool storedOutput as stable JSON", () => {
    // Risk 2: confirm the JSON.stringify path is deterministic for complex
    // tool results — what the model sees on the next turn is well-formed JSON
    // it can parse, not "[object Object]" or a coerced primitive.
    const complex = {
      stdout: "ok",
      exitCode: 0,
      meta: { latencyMs: 12, retries: [1, 2, 3], tags: { a: "x", b: null } },
    };
    const trace = makeTrace([
      makeStep({
        index: 0,
        type: "tool_call",
        toolName: "run_bash",
        storedOutput: complex,
      }),
    ]);
    const msgs = reconstructInitialMessages(trace, { toStep: 1 });
    expect(msgs[0]).toEqual({
      role: "tool",
      content: JSON.stringify(complex),
      toolName: "run_bash",
    });
    // Round-trip survives JSON.parse.
    expect(JSON.parse(msgs[0]?.content ?? "{}")).toEqual(complex);
  });

  it("renders undefined storedOutput as empty string", () => {
    const trace = makeTrace([makeStep({ index: 0, type: "llm_call", storedOutput: undefined })]);
    const msgs = reconstructInitialMessages(trace, { toStep: 1 });
    expect(msgs[0]).toEqual({ role: "assistant", content: "" });
  });

  describe("policy gating", () => {
    it("bails on hash-only with step index in message", () => {
      const trace = makeTrace([
        makeStep({ index: 0, type: "llm_call", storedOutput: "a" }),
        makeStep({ index: 1, type: "llm_call", policy: "hash-only" }),
      ]);
      expect(() => reconstructInitialMessages(trace, { toStep: 2 })).toThrowError(
        /step 1.*hash-only/,
      );
    });

    it("bails on hmac with step index in message", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", policy: "hmac" })]);
      expect(() => reconstructInitialMessages(trace, { toStep: 1 })).toThrowError(/step 0.*hmac/);
    });

    it("does NOT bail when the redacting step is past toStep", () => {
      const trace = makeTrace([
        makeStep({ index: 0, type: "llm_call", storedOutput: "ok" }),
        makeStep({ index: 1, type: "llm_call", policy: "hash-only" }),
      ]);
      // Only replay step 0 — the hash-only step is out of scope.
      expect(() => reconstructInitialMessages(trace, { toStep: 1 })).not.toThrow();
    });

    it("throws TraceReplayError (not a generic Error subclass)", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call", policy: "hmac" })]);
      try {
        reconstructInitialMessages(trace, { toStep: 1 });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TraceReplayError);
      }
    });
  });

  describe("bounds checking", () => {
    it("rejects negative toStep", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call" })]);
      expect(() => reconstructInitialMessages(trace, { toStep: -1 })).toThrowError(/non-negative/);
    });

    it("rejects non-integer toStep", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call" })]);
      expect(() => reconstructInitialMessages(trace, { toStep: 1.5 })).toThrowError(
        /non-negative integer/,
      );
    });

    it("rejects toStep past steps.length", () => {
      const trace = makeTrace([makeStep({ index: 0, type: "llm_call" })]);
      expect(() => reconstructInitialMessages(trace, { toStep: 99 })).toThrowError(
        /trace has only 1 steps/,
      );
    });

    it("accepts toStep === steps.length (replay whole trace)", () => {
      const trace = makeTrace([
        makeStep({ index: 0, type: "llm_call", storedOutput: "a" }),
        makeStep({ index: 1, type: "llm_call", storedOutput: "b" }),
      ]);
      const msgs = reconstructInitialMessages(trace, { toStep: 2 });
      expect(msgs).toHaveLength(2);
    });
  });
});
