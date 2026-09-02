/**
 * Tests for agent-sdk/src/tracking/agent-run-tracker.ts
 *
 * Coverage:
 *   start — validation: empty agentId/agentVersion/runId/model/provider,
 *            inserts correct SQL params, returns id from row,
 *            throws when no row returned, passes null for optional fields
 *   recordStep — validation: invalid uuid, negative tokens, float tokens,
 *                negative costUsd; correct SQL params, toolCalls defaults to 0
 *   finish — validation: invalid uuid, invalid status; correct SQL params,
 *             null for optional stopReason/errorMessage, all valid statuses accepted
 *
 * Ref: test coverage for agent-sdk/tracking/agent-run-tracker.ts (no prior tests)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRunTracker } from "../src/tracking/agent-run-tracker.js";
import type { DbClient } from "../src/tracking/agent-run-tracker.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeDb(rows: object[] = [{ id: UUID }]): {
  db: DbClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { db: { query } as DbClient, query };
}

const BASE_START = {
  agentId: "builder",
  agentVersion: "1.0.0",
  runId: UUID,
  model: "llama-3.3-70b",
  provider: "groq",
};

// ─── start() ─────────────────────────────────────────────────────────────────

describe("AgentRunTracker.start", () => {
  it("returns id from the inserted row", async () => {
    const { db } = makeDb([{ id: "abc-returned-id" }]);
    const tracker = createAgentRunTracker(db);
    // runId is a UUID so we use the standard UUID fixture
    const id = await tracker.start({ ...BASE_START, agentId: "b" });
    expect(id).toBe("abc-returned-id");
  });

  it("inserts with correct SQL params", async () => {
    const { db, query } = makeDb();
    const tracker = createAgentRunTracker(db);
    await tracker.start({
      ...BASE_START,
      tenantId: UUID,
      traceId: "trace-001",
    });
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe("builder");
    expect(params[1]).toBe("1.0.0");
    expect(params[2]).toBe(UUID);
    expect(params[3]).toBe("llama-3.3-70b");
    expect(params[4]).toBe("groq");
    expect(params[5]).toBe(UUID); // tenantId
    expect(params[6]).toBe("trace-001");
  });

  it("passes null for tenantId and traceId when not provided", async () => {
    const { db, query } = makeDb();
    const tracker = createAgentRunTracker(db);
    await tracker.start(BASE_START);
    const params = query.mock.calls[0][1];
    expect(params[5]).toBeNull();
    expect(params[6]).toBeNull();
  });

  it("throws when DB returns no row", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(tracker.start(BASE_START)).rejects.toThrow("insert did not return an id");
  });

  it.each(["agentId", "agentVersion", "model", "provider"])(
    "throws when %s is empty",
    async (field) => {
      const { db } = makeDb();
      const tracker = createAgentRunTracker(db);
      const input = { ...BASE_START, [field]: "" };
      await expect(tracker.start(input)).rejects.toThrow(field);
    },
  );
});

// ─── recordStep() ─────────────────────────────────────────────────────────────

describe("AgentRunTracker.recordStep", () => {
  it("sends correct SQL params for a step", async () => {
    const { db, query } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await tracker.recordStep(UUID, {
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: 2,
      costUsd: 0.001234,
    });
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe(UUID);
    expect(params[1]).toBe(100);
    expect(params[2]).toBe(50);
    expect(params[3]).toBe(2);
    expect(params[4]).toBe("0.001234"); // fixed(6)
  });

  it("defaults toolCalls to 0 when not provided", async () => {
    const { db, query } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await tracker.recordStep(UUID, {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
    });
    const params = query.mock.calls[0][1];
    expect(params[3]).toBe(0);
  });

  it("throws on invalid UUID", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(
      tracker.recordStep("not-a-uuid", {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      }),
    ).rejects.toThrow("UUID");
  });

  it("throws on negative inputTokens", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(
      tracker.recordStep(UUID, { inputTokens: -1, outputTokens: 0, costUsd: 0 }),
    ).rejects.toThrow("inputTokens");
  });

  it("throws on float inputTokens", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(
      tracker.recordStep(UUID, {
        inputTokens: 1.5,
        outputTokens: 0,
        costUsd: 0,
      }),
    ).rejects.toThrow("inputTokens");
  });

  it("throws on negative costUsd", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(
      tracker.recordStep(UUID, {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: -0.001,
      }),
    ).rejects.toThrow("costUsd");
  });

  it("accepts costUsd=0", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(
      tracker.recordStep(UUID, { inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    ).resolves.toBeUndefined();
  });
});

// ─── finish() ─────────────────────────────────────────────────────────────────

describe("AgentRunTracker.finish", () => {
  it.each(["success", "failed", "timeout", "incoherent"] as const)(
    "accepts status '%s'",
    async (status) => {
      const { db } = makeDb([]);
      const tracker = createAgentRunTracker(db);
      await expect(tracker.finish(UUID, { status })).resolves.toBeUndefined();
    },
  );

  it("throws for unknown status", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(tracker.finish(UUID, { status: "cancelled" as never })).rejects.toThrow("status");
  });

  it("throws on invalid UUID", async () => {
    const { db } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await expect(tracker.finish("bad-id", { status: "success" })).rejects.toThrow("UUID");
  });

  it("passes null for stopReason and errorMessage when not provided", async () => {
    const { db, query } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await tracker.finish(UUID, { status: "success" });
    const params = query.mock.calls[0][1];
    expect(params[2]).toBeNull(); // stopReason
    expect(params[3]).toBeNull(); // errorMessage
  });

  it("passes stopReason and errorMessage when provided", async () => {
    const { db, query } = makeDb([]);
    const tracker = createAgentRunTracker(db);
    await tracker.finish(UUID, {
      status: "failed",
      stopReason: "budget_exhausted",
      errorMessage: "spent too much",
    });
    const params = query.mock.calls[0][1];
    expect(params[1]).toBe("failed");
    expect(params[2]).toBe("budget_exhausted");
    expect(params[3]).toBe("spent too much");
  });
});
