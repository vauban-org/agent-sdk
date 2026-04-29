/**
 * Self-test: the conformance suites themselves run clean against a
 * reference mock impl. Proves the suites are importable and not broken.
 */

import { describe, expect, it, vi } from "vitest";
import {
  brainPortConformance,
  dbPortConformance,
  loggerPortConformance,
  outcomePortConformance,
} from "../src/testing/index.js";
import { noopLogger } from "../src/ports/index.js";
import type { BrainPort, DbPort, OutcomePort } from "../src/index.js";

// Reference mocks — impls that we know satisfy the contracts.

const mockBrain: BrainPort = {
  archiveKnowledge: async (entry) => ({
    id: `mock-${Date.now()}`,
    content: entry.content,
  }),
  queryKnowledge: async () => [],
};

const mockOutcome: OutcomePort = {
  recordOutcomeAsync: () => {},
};

const mockDb: DbPort = {
  async query<T extends object>(_sql: string, _params?: unknown[]) {
    return { rows: [{ n: 1 } as unknown as T], rowCount: 1 };
  },
};

brainPortConformance({
  describe,
  it,
  // biome-ignore lint/suspicious/noExplicitAny: vitest matcher shape matches
  expect: expect as any,
  factory: () => mockBrain,
});

outcomePortConformance({
  describe,
  it,
  expect,
  factory: () => mockOutcome,
});

loggerPortConformance({
  describe,
  it,
  expect,
  factory: () => noopLogger,
});

dbPortConformance({
  describe,
  it,
  expect,
  factory: () => mockDb,
});

describe("conformance self-test metadata", () => {
  it("vi is available (sanity)", () => {
    expect(typeof vi.fn).toBe("function");
  });
});
