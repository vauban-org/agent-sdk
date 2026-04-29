/**
 * Tests for the Ports module (SDK v0.2.0).
 *
 * These tests assert the shape of the port contracts. Ports are pure
 * interfaces, so tests focus on: (a) noopLogger implements LoggerPort,
 * (b) mock implementations satisfy the interfaces, (c) BrainPort can be
 * called with the minimal entry shape without TS complaints.
 */

import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  type BrainPort,
  type BrainEntryInput,
  type LoggerPort,
  type OutcomePort,
  type DbPort,
} from "../src/index.js";

describe("ports — LoggerPort", () => {
  it("noopLogger implements all methods without throwing", () => {
    expect(() => noopLogger.debug("hi")).not.toThrow();
    expect(() => noopLogger.info({ foo: 1 }, "msg")).not.toThrow();
    expect(() => noopLogger.warn("hi")).not.toThrow();
    expect(() => noopLogger.error({ err: "x" }, "oops")).not.toThrow();
  });

  it("accepts a Pino-compatible concrete impl", () => {
    const spy = vi.fn();
    const logger: LoggerPort = {
      debug: spy,
      info: spy,
      warn: spy,
      error: spy,
    };
    logger.info({ agentId: "test" }, "boot");
    expect(spy).toHaveBeenCalledWith({ agentId: "test" }, "boot");
  });
});

describe("ports — BrainPort", () => {
  it("mock impl satisfies the contract", async () => {
    const archive = vi.fn().mockResolvedValue({
      id: "e1",
      content: "test entry",
      category: "pattern",
    });
    const brain: BrainPort = { archiveKnowledge: archive };

    const entry: BrainEntryInput = {
      content: "test entry",
      category: "pattern",
      tags: ["sdk", "ports"],
    };
    const result = await brain.archiveKnowledge(entry);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("e1");
    expect(archive).toHaveBeenCalledWith(entry);
  });

  it("supports null return (fire-and-forget failure mode)", async () => {
    const brain: BrainPort = {
      archiveKnowledge: vi.fn().mockResolvedValue(null),
    };
    const result = await brain.archiveKnowledge({ content: "x" });
    expect(result).toBeNull();
  });
});

describe("ports — OutcomePort", () => {
  it("recordOutcomeAsync is fire-and-forget (void return)", () => {
    const spy = vi.fn();
    const outcome: OutcomePort = { recordOutcomeAsync: spy };
    outcome.recordOutcomeAsync({ id: "run-1", agent_id: "market-radar" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({
      id: "run-1",
      agent_id: "market-radar",
    });
  });
});

describe("ports — DbPort", () => {
  it("mock Pg-compatible impl works", async () => {
    const db: DbPort = {
      query: vi.fn().mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 }),
    };
    const result = await db.query<{ count: number }>("SELECT 1");
    expect(result.rows[0].count).toBe(1);
  });
});
