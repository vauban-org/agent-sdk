/**
 * Tests for the canonical AG-UI event-name helpers (3.0.0+).
 *
 * Since 3.0.0 the SDK emits only UPPER_SNAKE_CASE canonical types. The
 * legacy bidirectional map and EventNamingMode have been removed. This
 * suite verifies the retained surface:
 *   - ALL_KNOWN_EVENT_TYPES  — union of canonical + legacy shim strings
 *   - isKnownEventType       — type guard
 *   - toCanonicalEventType   — emit-boundary translator (dotted → UPPER_SNAKE)
 *
 * @since 3.0.0
 */

import { describe, expect, it } from "vitest";

import {
  ALL_KNOWN_EVENT_TYPES,
  isKnownEventType,
  toCanonicalEventType,
} from "../../src/remote/event-name-map.js";

const DOTTED_TYPES = [
  "run.start",
  "run.step",
  "run.finished",
  "assistant.delta",
  "assistant.message",
  "tool.intent",
  "tool.call.start",
  "tool.call.end",
  "hitl.request",
  "hitl.resolved",
  "instruction.injected",
  "state",
] as const;

const CANONICAL_TYPES = [
  "RUN_STARTED",
  "STEP_STARTED",
  "RUN_FINISHED",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "CUSTOM_TOOL_INTENT",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "CUSTOM_HITL_REQUEST",
  "CUSTOM_HITL_RESOLVED",
  "CUSTOM_INSTRUCTION_INJECTED",
  "STATE_SNAPSHOT",
] as const;

describe("ALL_KNOWN_EVENT_TYPES — union of dotted + canonical", () => {
  it("includes every dotted-lowercase shim type", () => {
    for (const t of DOTTED_TYPES) {
      expect(ALL_KNOWN_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("includes every canonical type", () => {
    for (const t of CANONICAL_TYPES) {
      expect(ALL_KNOWN_EVENT_TYPES.has(t)).toBe(true);
    }
  });

  it("includes CUSTOM_TEAMMATE_DELIVERY (sprint-893 d1) ; a canonical-only type with no dotted shim", () => {
    expect(ALL_KNOWN_EVENT_TYPES.has("CUSTOM_TEAMMATE_DELIVERY")).toBe(true);
    expect(isKnownEventType("CUSTOM_TEAMMATE_DELIVERY")).toBe(true);
    // Idempotent ; it was never dotted, so translation is a no-op passthrough.
    expect(toCanonicalEventType("CUSTOM_TEAMMATE_DELIVERY")).toBe("CUSTOM_TEAMMATE_DELIVERY");
  });

  it("rejects an unknown random string", () => {
    expect(ALL_KNOWN_EVENT_TYPES.has("totally.unknown")).toBe(false);
    expect(ALL_KNOWN_EVENT_TYPES.has("UNKNOWN_FOO")).toBe(false);
    expect(ALL_KNOWN_EVENT_TYPES.has("")).toBe(false);
  });
});

describe("isKnownEventType — guard helper", () => {
  it("accepts every dotted shim type", () => {
    for (const t of DOTTED_TYPES) expect(isKnownEventType(t)).toBe(true);
  });

  it("accepts every canonical type", () => {
    for (const t of CANONICAL_TYPES) expect(isKnownEventType(t)).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isKnownEventType("totally.unknown")).toBe(false);
    expect(isKnownEventType("RUN.STARTED")).toBe(false); // mixed case
    expect(isKnownEventType("Run.Start")).toBe(false);
    expect(isKnownEventType("")).toBe(false);
  });
});

describe("toCanonicalEventType — emit-boundary translator", () => {
  it("translates every dotted type to its canonical peer", () => {
    expect(toCanonicalEventType("run.start")).toBe("RUN_STARTED");
    expect(toCanonicalEventType("run.step")).toBe("STEP_STARTED");
    expect(toCanonicalEventType("run.finished")).toBe("RUN_FINISHED");
    expect(toCanonicalEventType("assistant.delta")).toBe("TEXT_MESSAGE_CONTENT");
    expect(toCanonicalEventType("assistant.message")).toBe("TEXT_MESSAGE_END");
    expect(toCanonicalEventType("tool.call.start")).toBe("TOOL_CALL_START");
    expect(toCanonicalEventType("tool.call.end")).toBe("TOOL_CALL_END");
    expect(toCanonicalEventType("state")).toBe("STATE_SNAPSHOT");
  });

  it("projects Vauban extensions onto CUSTOM_* canonical peers", () => {
    expect(toCanonicalEventType("tool.intent")).toBe("CUSTOM_TOOL_INTENT");
    expect(toCanonicalEventType("hitl.request")).toBe("CUSTOM_HITL_REQUEST");
    expect(toCanonicalEventType("hitl.resolved")).toBe("CUSTOM_HITL_RESOLVED");
    expect(toCanonicalEventType("instruction.injected")).toBe("CUSTOM_INSTRUCTION_INJECTED");
  });

  it("leaves a canonical type unchanged (idempotent)", () => {
    for (const t of CANONICAL_TYPES) {
      expect(toCanonicalEventType(t)).toBe(t);
    }
  });

  it("leaves an unknown type unchanged (passthrough)", () => {
    expect(toCanonicalEventType("custom.unknown")).toBe("custom.unknown");
    expect(toCanonicalEventType("UNRECOGNIZED_FOO")).toBe("UNRECOGNIZED_FOO");
  });

  it("every dotted type translates then back to dotted via ALL_KNOWN_EVENT_TYPES (coverage check)", () => {
    for (const t of DOTTED_TYPES) {
      const canonical = toCanonicalEventType(t);
      expect(canonical).not.toBe(t); // must have been translated
      expect(ALL_KNOWN_EVENT_TYPES.has(canonical)).toBe(true);
    }
  });
});
