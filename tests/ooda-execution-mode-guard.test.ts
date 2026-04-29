/**
 * EXECUTION_MODE guard — unit tests.
 *
 * Sprint: command-center:sprint-525:quick-2
 */

import { describe, expect, it } from "vitest";
import {
  assertExecutionMode,
  readExecutionModeFromEnv,
} from "../src/orchestration/ooda/execution-mode-guard.js";

describe("assertExecutionMode", () => {
  it("accepts 'dry-run'", () => {
    expect(() => assertExecutionMode("dry-run")).not.toThrow();
  });

  it("accepts 'live'", () => {
    expect(() => assertExecutionMode("live")).not.toThrow();
  });

  it("rejects undefined with an actionable message", () => {
    expect(() => assertExecutionMode(undefined)).toThrow(/EXECUTION_MODE.*'dry-run' \| 'live'/);
  });

  it("rejects an empty string", () => {
    expect(() => assertExecutionMode("")).toThrow(/EXECUTION_MODE/);
  });

  it("rejects an unrelated string ('production')", () => {
    expect(() => assertExecutionMode("production")).toThrow(/EXECUTION_MODE/);
  });

  it("rejects mixed-case variants", () => {
    expect(() => assertExecutionMode("Live")).toThrow(/EXECUTION_MODE/);
    expect(() => assertExecutionMode("DRY-RUN")).toThrow(/EXECUTION_MODE/);
  });

  it("rejects non-string types (number, null, object)", () => {
    expect(() => assertExecutionMode(0 as unknown)).toThrow(/EXECUTION_MODE/);
    expect(() => assertExecutionMode(null as unknown)).toThrow(/EXECUTION_MODE/);
    expect(() => assertExecutionMode({} as unknown)).toThrow(/EXECUTION_MODE/);
  });

  it("acts as a TypeScript narrowing assertion", () => {
    const raw: unknown = "live";
    assertExecutionMode(raw);
    // After the assertion, raw is narrowed to ExecutionMode — no cast needed.
    const ok: "dry-run" | "live" = raw;
    expect(ok).toBe("live");
  });
});

describe("readExecutionModeFromEnv", () => {
  it("reads EXECUTION_MODE by default", () => {
    expect(readExecutionModeFromEnv({ EXECUTION_MODE: "dry-run" })).toBe("dry-run");
    expect(readExecutionModeFromEnv({ EXECUTION_MODE: "live" })).toBe("live");
  });

  it("supports a custom env variable name", () => {
    expect(readExecutionModeFromEnv({ AGENT_MODE: "live" }, "AGENT_MODE")).toBe("live");
  });

  it("throws when the variable is missing", () => {
    expect(() => readExecutionModeFromEnv({})).toThrow(/EXECUTION_MODE/);
  });

  it("throws on unrelated value", () => {
    expect(() => readExecutionModeFromEnv({ EXECUTION_MODE: "production" })).toThrow(
      /EXECUTION_MODE/,
    );
  });
});
