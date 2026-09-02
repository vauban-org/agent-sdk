/**
 * AgentLoop × argsPreview ; bounding the tool-call args preview PER FIELD
 * instead of slicing the whole serialized JSON blob.
 *
 * Regression coverage for sprint-1067 t3-args-truncation: the old
 * `JSON.stringify(args).slice(0, 500)` cut mid-string or mid-structure for
 * almost any multi-argument call, handing the client invalid JSON it could
 * only recover from field-by-field (t3-ux-polish's salvage band-aid, marked
 * "tronqué par l'hôte"). Truncating each field BEFORE the final
 * `JSON.stringify` keeps the emitted preview valid, whole-parsable JSON for
 * the common case. `tool.intent` and `tool.call.start` share the exact same
 * `argsPreview` local (minimal-loop.ts), so exercising the `tool.call.start`
 * path (always emitted) covers both wire consumers.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type ProviderRouter,
  type SessionEvent,
  type SessionEventSink,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Provider that calls `tool_under_test` once with the given args, then
 * finalises ; same shape as `loop-veto.test.ts`'s harness. */
function makeOneToolThenDone(args: Record<string, unknown>): ProviderRouter {
  let called = false;
  return {
    async complete() {
      if (!called) {
        called = true;
        return {
          provider: "mock",
          model: "mock",
          content: "calling the tool",
          toolCalls: [{ id: "c-1", name: "tool_under_test", args }],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      }
      return {
        provider: "mock",
        model: "mock",
        content: "all done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
      };
    },
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistryImpl();
  registry.register({
    name: "tool_under_test",
    description: "a test tool",
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => ({ ok: true }),
  });
  return registry;
}

async function runAndCollectEvents(args: Record<string, unknown>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const sink: SessionEventSink = { emit: (e) => events.push(e) };
  const loop = new AgentLoop({
    agentId: "tester",
    agentVersion: "test",
    systemPrompt: "sys",
    provider: makeOneToolThenDone(args),
    tools: makeRegistry(),
    budget: createBudgetState({ maxSteps: 5 }),
    disableLoopDetection: true,
    eventSink: sink,
  });
  await loop.run("do something");
  return events;
}

function toolCallStartArgsPreview(events: SessionEvent[]): string {
  const e = events.find((ev) => ev.type === "tool.call.start");
  if (!e || e.type !== "tool.call.start") throw new Error("no tool.call.start event emitted");
  return e.data.argsPreview;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentLoop argsPreview ; per-field bound (sprint-1067 t3-args-truncation)", () => {
  it("keeps a multi-field call with long string values whole-parsable (the bug: a global slice cut mid-string)", async () => {
    const fieldA = "a".repeat(800);
    const fieldB = "b".repeat(800);
    const args = { fieldA, fieldB, fieldC: "short" };

    const preview = toolCallStartArgsPreview(await runAndCollectEvents(args));

    const parsed = JSON.parse(preview) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["fieldA", "fieldB", "fieldC"]);
    expect(parsed.fieldC).toBe("short");
    // Each long field is bounded on its OWN, not sacrificed so a sibling
    // field can fit inside a shared global budget.
    expect((parsed.fieldA as string).length).toBeLessThan(fieldA.length);
    expect((parsed.fieldB as string).length).toBeLessThan(fieldB.length);
  });

  it("leaves a short-args call byte-identical to a plain JSON.stringify (no truncation artifact when none is needed)", async () => {
    const args = { n: 1, ok: true, name: "short" };

    const preview = toolCallStartArgsPreview(await runAndCollectEvents(args));

    expect(preview).toBe(JSON.stringify(args));
  });

  it("leaves non-string fields intact regardless of magnitude", async () => {
    const args = { count: 123456789, ratio: 0.123456789, flag: false, nothing: null };

    const preview = toolCallStartArgsPreview(await runAndCollectEvents(args));

    expect(JSON.parse(preview)).toEqual(args);
  });

  it("bounds a pathological field count while staying valid JSON", async () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 80; i++) args[`field${i}`] = i;

    const preview = toolCallStartArgsPreview(await runAndCollectEvents(args));

    const parsed = JSON.parse(preview) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeLessThan(80);
    // The kept fields are the real ones, in order ; a marker records the
    // omission rather than silently dropping data with no trace.
    expect(parsed.field0).toBe(0);
  });
});
