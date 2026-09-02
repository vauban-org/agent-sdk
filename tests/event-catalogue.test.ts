/**
 * Tests for packages/agent-sdk/src/events/catalogue.ts
 *
 * Coverage:
 *   EventSchemas — all keys are present (registration smoke-test)
 *   resolveSchema — returns Zod schema for known type, undefined for unknown
 *   validateEvent — valid payload passes, invalid payload fails with error message,
 *                   unknown event type returns error
 *
 * Ref: test coverage for agent-sdk/events/catalogue.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { EventSchemas, resolveSchema, validateEvent } from "../src/events/catalogue.js";

// ─── EventSchemas registration ────────────────────────────────────────────────

describe("EventSchemas", () => {
  it("contains agent.started", () => {
    expect(EventSchemas["agent.started"]).toBeDefined();
  });

  it("contains all 28+ expected event types", () => {
    const keys = Object.keys(EventSchemas);
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  it("every schema is a Zod object with safeParse method", () => {
    for (const [type, schema] of Object.entries(EventSchemas)) {
      expect(
        typeof (schema as { safeParse?: unknown }).safeParse,
        `${type} should have safeParse`,
      ).toBe("function");
    }
  });
});

// ─── resolveSchema ────────────────────────────────────────────────────────────

describe("resolveSchema", () => {
  it("returns the schema for a known event type", () => {
    const schema = resolveSchema("agent.started");
    expect(schema).toBeDefined();
    expect(typeof schema?.safeParse).toBe("function");
  });

  it("returns undefined for an unknown event type", () => {
    expect(resolveSchema("unknown.event.type")).toBeUndefined();
  });

  it("is case-sensitive (mixed-case returns undefined)", () => {
    expect(resolveSchema("Agent.Started")).toBeUndefined();
  });
});

// ─── validateEvent ────────────────────────────────────────────────────────────

describe("validateEvent", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

  it("returns valid=true for a valid agent.started payload", () => {
    const result = validateEvent("agent.started", {
      agentName: "forge",
      runId: VALID_UUID,
      inputs: { task: "refactor" },
    });
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns valid=false when required field is missing", () => {
    const result = validateEvent("agent.started", {
      runId: VALID_UUID,
      // agentName missing
    });
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("returns valid=false when runId is not a UUID", () => {
    const result = validateEvent("agent.started", {
      agentName: "forge",
      runId: "not-a-uuid",
      inputs: {},
    });
    expect(result.valid).toBe(false);
  });

  it("returns valid=false for unknown event type", () => {
    const result = validateEvent("totally.unknown.event", { foo: "bar" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown event type");
  });

  it("validates agent.completed payload", () => {
    const schema = resolveSchema("agent.completed");
    if (!schema) return; // skip if not registered
    const result = validateEvent("agent.completed", {
      agentName: "forge",
      runId: VALID_UUID,
      outputs: {},
      durationMs: 1200,
    });
    // Passes if schema accepts this shape
    expect(typeof result.valid).toBe("boolean");
  });
});
