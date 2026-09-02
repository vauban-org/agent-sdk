/**
 * localSqliteTelemetrySink — schema, write, idempotency tests.
 *
 * Uses `:memory:` SQLite so tests are hermetic. Requires `better-sqlite3`
 * installed as a dev/peer dep. If absent, the sink degrades to no-op and
 * the assertions tagged "degraded" pass.
 *
 * Ref: command-center:sprint-693:sink-sqlite
 */

import { describe, expect, it } from "vitest";

import { localSqliteTelemetrySink } from "./sqlite.js";

function isBetterSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

const RUN_START = {
  runId: "11111111-1111-1111-1111-111111111111",
  agentId: "agent-x",
  agentVersion: "1.0.0",
  model: "test",
  provider: "test",
  startedAt: "2026-05-16T17:00:00.000Z",
};

describe("localSqliteTelemetrySink", () => {
  it("has a stable sink name", () => {
    const sink = localSqliteTelemetrySink({ path: ":memory:" });
    expect(sink.name === "sqlite" || sink.name.startsWith("sqlite:degraded")).toBe(true);
  });

  it("never throws on start/step/finish", async () => {
    const sink = localSqliteTelemetrySink({ path: ":memory:" });
    await expect(sink.start(RUN_START)).resolves.toBeUndefined();
    await expect(
      sink.step("run-1", {
        stepIndex: 0,
        kind: "observe",
        status: "completed",
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      sink.finish("run-1", {
        status: "success",
        finishedAt: "2026-05-16T17:00:01.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it.skipIf(!isBetterSqliteAvailable())(
    "persists agent_run rows and supports finish update",
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BetterSqlite = require("better-sqlite3");
      const sink = localSqliteTelemetrySink({ path: ":memory:" });

      await sink.start(RUN_START);
      await sink.finish(RUN_START.runId, {
        status: "success",
        finishedAt: "2026-05-16T17:00:01.000Z",
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCostUsd: 0.01,
      });

      // Re-open the file via the same in-memory path is impossible; instead,
      // we trust the contract that no exceptions = persisted (since SQLite
      // writes are sync). Spot-check by writing a separate file.
      const path = `/tmp/vauban-telemetry-test-${Date.now()}.db`;
      const sink2 = localSqliteTelemetrySink({ path });
      await sink2.start(RUN_START);
      await sink2.finish(RUN_START.runId, {
        status: "success",
        finishedAt: "2026-05-16T17:00:01.000Z",
      });

      const db = new BetterSqlite(path);
      const row = db.prepare("SELECT * FROM agent_run WHERE run_id = ?").get(RUN_START.runId);
      db.close();

      expect(row).toBeDefined();
      expect(row.agent_id).toBe("agent-x");
      expect(row.status).toBe("success");
      expect(row.started_at).toBe(RUN_START.startedAt);
    },
  );

  it.skipIf(!isBetterSqliteAvailable())("idempotent start (ON CONFLICT DO NOTHING)", async () => {
    const path = `/tmp/vauban-telemetry-test-${Date.now()}.db`;
    const sink = localSqliteTelemetrySink({ path });
    await sink.start(RUN_START);
    await sink.start(RUN_START); // second call — should not throw or duplicate

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite = require("better-sqlite3");
    const db = new BetterSqlite(path);
    const count = db
      .prepare("SELECT COUNT(*) c FROM agent_run WHERE run_id = ?")
      .get(RUN_START.runId);
    db.close();
    expect(count.c).toBe(1);
  });
});
