/**
 * Validates the conformance suite factories themselves using mock port
 * implementations. Each suite factory receives a minimal mock that satisfies
 * the contract — if the suite passes, the suite factory works correctly.
 *
 * Coverage:
 *   src/testing/logger-conformance.ts — loggerPortConformance
 *   src/testing/db-conformance.ts    — dbPortConformance
 *   src/testing/outcome-conformance.ts — outcomePortConformance
 */

import { describe, expect, it } from "vitest";
import { dbPortConformance } from "../src/testing/db-conformance.js";
import { loggerPortConformance } from "../src/testing/logger-conformance.js";
import { outcomePortConformance } from "../src/testing/outcome-conformance.js";

// ─── LoggerPort conformance (via mock impl) ──────────────────────────────────

loggerPortConformance({
  describe,
  it,
  expect,
  factory: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: (bindings: Record<string, unknown>) => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      _bindings: bindings,
    }),
  }),
});

// ─── DbPort conformance (via mock impl) ──────────────────────────────────────

dbPortConformance({
  describe,
  it,
  expect,
  factory: () => ({
    query: async (_sql: string, _params?: unknown[]) => ({
      rows: [{ n: 1 }],
      rowCount: 1,
    }),
  }),
  selectOneSql: "SELECT 1 AS n",
});

// ─── OutcomePort conformance (via mock impl) ──────────────────────────────────

outcomePortConformance({
  describe,
  it,
  expect,
  factory: () => ({
    recordOutcomeAsync: (_input: unknown) => {
      return undefined;
    },
  }),
});
