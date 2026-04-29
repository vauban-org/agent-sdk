/**
 * Minimal OODA agent example — V6 risk 19 mitigation (≤50 lines).
 *
 * Sprint: command-center:sprint-525:quick-1
 *
 * Demonstrates type-safe phase chaining and one-shot triggerCycle.
 */

import { describe, it, expect } from "vitest";
import {
  createOODAAgent,
  noopLogger,
  type DbClient,
} from "../src/index.js";

const fakeDb: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) };

describe("OODA — minimal example (V6 risk 19, ≤50 lines)", () => {
  it("runs one cycle and threads typed data observe→feedback", async () => {
    let lastFeedback = 0;
    const agent = createOODAAgent<unknown, number, number, number, number, number>({
      agentId: "minimal",
      intervalMs: 0,
      executionMode: "dry-run",
      db: fakeDb,
      logger: noopLogger,
      phases: {
        observe: { type: "observation", readOnly: true, fn: async () => 1 },
        orient: {
          type: "retrieval",
          readOnly: true,
          fn: async (i) => i + 1,
        },
        decide: { type: "decision", fn: async (i) => i * 2 },
        act: { type: "execution", fn: async (i) => i + 10 },
        feedback: {
          type: "feedback",
          fn: async (i) => {
            lastFeedback = i;
            return i;
          },
        },
      },
    });
    const r = await agent.triggerCycle();
    expect(r.status).toBe("succeeded");
    expect(lastFeedback).toBe(14); // ((1+1)*2)+10 = 14
  });
});
