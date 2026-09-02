/**
 * Tests for:
 *   src/orchestration/ooda/errors.ts
 *   src/orchestration/ooda/execution-mode-guard.ts
 *
 * Coverage:
 *   MissingDependencyError — .name, .port, message contains port, instanceof chain
 *   DepsValidationError — .name, message, instanceof chain
 *   assertExecutionMode — passes for 'dry-run' and 'live',
 *     throws for undefined/null/empty/wrong string
 *   readExecutionModeFromEnv — returns 'dry-run'/'live' from env map,
 *     throws when EXECUTION_MODE missing,
 *     uses custom varName when provided
 *
 * Ref: test coverage for ooda errors + execution-mode-guard (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { DepsValidationError, MissingDependencyError } from "../src/orchestration/ooda/errors.js";
import {
  assertExecutionMode,
  readExecutionModeFromEnv,
} from "../src/orchestration/ooda/execution-mode-guard.js";

// ─── MissingDependencyError ────────────────────────────────────────────────────

describe("MissingDependencyError", () => {
  it(".name is 'MissingDependencyError'", () => {
    expect(new MissingDependencyError("llm").name).toBe("MissingDependencyError");
  });

  it("stores port field", () => {
    expect(new MissingDependencyError("brain").port).toBe("brain");
  });

  it("message references the port", () => {
    const err = new MissingDependencyError("citadel");
    expect(err.message).toContain("citadel");
  });

  it("instanceof Error and MissingDependencyError", () => {
    const err = new MissingDependencyError("llm");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissingDependencyError);
  });
});

// ─── DepsValidationError ──────────────────────────────────────────────────────

describe("DepsValidationError", () => {
  it(".name is 'DepsValidationError'", () => {
    expect(new DepsValidationError("invalid deps").name).toBe("DepsValidationError");
  });

  it("message matches constructor argument", () => {
    const err = new DepsValidationError("conflicting ports");
    expect(err.message).toBe("conflicting ports");
  });

  it("instanceof Error and DepsValidationError", () => {
    const err = new DepsValidationError("err");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DepsValidationError);
  });
});

// ─── assertExecutionMode ──────────────────────────────────────────────────────

describe("assertExecutionMode", () => {
  it("does not throw for 'dry-run'", () => {
    expect(() => assertExecutionMode("dry-run")).not.toThrow();
  });

  it("does not throw for 'live'", () => {
    expect(() => assertExecutionMode("live")).not.toThrow();
  });

  it("throws for undefined", () => {
    expect(() => assertExecutionMode(undefined)).toThrow("EXECUTION_MODE");
  });

  it("throws for null", () => {
    expect(() => assertExecutionMode(null)).toThrow("EXECUTION_MODE");
  });

  it("throws for empty string", () => {
    expect(() => assertExecutionMode("")).toThrow("EXECUTION_MODE");
  });

  it("throws for unknown string 'simulate'", () => {
    expect(() => assertExecutionMode("simulate")).toThrow("EXECUTION_MODE");
  });

  it("throws for boolean true", () => {
    expect(() => assertExecutionMode(true)).toThrow();
  });
});

// ─── readExecutionModeFromEnv ─────────────────────────────────────────────────

describe("readExecutionModeFromEnv", () => {
  it("returns 'dry-run' from env map", () => {
    expect(readExecutionModeFromEnv({ EXECUTION_MODE: "dry-run" })).toBe("dry-run");
  });

  it("returns 'live' from env map", () => {
    expect(readExecutionModeFromEnv({ EXECUTION_MODE: "live" })).toBe("live");
  });

  it("throws when EXECUTION_MODE is missing", () => {
    expect(() => readExecutionModeFromEnv({})).toThrow("EXECUTION_MODE");
  });

  it("throws when EXECUTION_MODE has wrong value", () => {
    expect(() => readExecutionModeFromEnv({ EXECUTION_MODE: "production" })).toThrow(
      "EXECUTION_MODE",
    );
  });

  it("reads from custom varName when provided", () => {
    expect(readExecutionModeFromEnv({ AGENT_MODE: "live" }, "AGENT_MODE")).toBe("live");
  });

  it("throws when custom varName is missing", () => {
    expect(() => readExecutionModeFromEnv({ EXECUTION_MODE: "live" }, "AGENT_MODE")).toThrow();
  });
});
