/**
 * Tests for `OutgoingMessageStore` (T6h — durable outgoing relay frames).
 *
 * Covers:
 *   - enqueue while disconnected, reconnect, verify frames flushed in FIFO
 *   - send failure increments attempts
 *   - after MAX_OUTGOING_ATTEMPTS the frame is considered exhausted
 *   - pendingCount returns accurate count
 *   - close() is idempotent; subsequent calls do not throw
 *   - markDelivered removes the row
 *   - frames survive close + reopen (durability contract)
 *   - outgoingStorePath honors PRESTE_HOME
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTGOING_ATTEMPTS,
  OutgoingMessageStore,
  outgoingStorePath,
} from "../../src/remote/outgoing-store.js";

describe("OutgoingMessageStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdk-outgoing-store-"));
    dbPath = join(tmpDir, "outgoing.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Core contract ────────────────────────────────────────────────────────

  it("creates the parent directory lazily for nested paths", () => {
    const nested = join(tmpDir, "a", "b", "out.db");
    const s = new OutgoingMessageStore({ dbPath: nested });
    expect(s.isClosed).toBe(false);
    s.close();
  });

  it("pendingCount returns 0 on a fresh store", () => {
    const s = new OutgoingMessageStore({ dbPath });
    expect(s.pendingCount("session-1")).toBe(0);
    s.close();
  });

  it("enqueue while disconnected — frames preserved in FIFO order", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess", "frame-A");
    s.enqueue("sess", "frame-B");
    s.enqueue("sess", "frame-C");

    expect(s.pendingCount("sess")).toBe(3);

    const batch = s.dequeueBatch("sess", 10);
    expect(batch.map((r) => r.frame)).toEqual(["frame-A", "frame-B", "frame-C"]);
    s.close();
  });

  it("markDelivered removes the row and decrements pendingCount", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess", "frame-1");
    s.enqueue("sess", "frame-2");

    const [first] = s.dequeueBatch("sess", 10);
    s.markDelivered(first.id);

    expect(s.pendingCount("sess")).toBe(1);
    const remaining = s.dequeueBatch("sess", 10);
    expect(remaining[0].frame).toBe("frame-2");
    s.close();
  });

  // ── Retry / failure tracking ─────────────────────────────────────────────

  it("markFailed increments attempts and sets last_attempt_at", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess", "bad-frame");

    const [row] = s.dequeueBatch("sess", 10);
    expect(row.attempts).toBe(0);
    expect(row.lastAttemptAt).toBeNull();

    const before = Date.now();
    s.markFailed(row.id);
    const after = Date.now();

    const [updated] = s.dequeueBatch("sess", 10);
    expect(updated.attempts).toBe(1);
    expect(updated.lastAttemptAt).toBeGreaterThanOrEqual(before);
    expect(updated.lastAttemptAt).toBeLessThanOrEqual(after);
    s.close();
  });

  it("markFailed can be called multiple times — attempts accumulates", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess", "retried");

    const [row] = s.dequeueBatch("sess", 10);
    for (let i = 0; i < 5; i++) s.markFailed(row.id);

    const [r] = s.dequeueBatch("sess", 10);
    expect(r.attempts).toBe(5);
    s.close();
  });

  it(`after ${MAX_OUTGOING_ATTEMPTS} failed attempts the frame is considered exhausted`, () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess", "exhausted-frame");

    const [row] = s.dequeueBatch("sess", 10);

    // Apply exactly MAX_OUTGOING_ATTEMPTS failures.
    for (let i = 0; i < MAX_OUTGOING_ATTEMPTS; i++) s.markFailed(row.id);

    const [r] = s.dequeueBatch("sess", 10);
    // The caller should drop frames at or beyond the threshold.
    expect(r.attempts).toBeGreaterThanOrEqual(MAX_OUTGOING_ATTEMPTS);
    // Simulate the drop: markDelivered removes it.
    s.markDelivered(r.id);
    expect(s.pendingCount("sess")).toBe(0);
    s.close();
  });

  // ── Durability ────────────────────────────────────────────────────────────

  it("frames survive close + reopen (durability contract)", () => {
    const s1 = new OutgoingMessageStore({ dbPath });
    s1.enqueue("sess", "durable-A");
    s1.enqueue("sess", "durable-B");
    s1.close();

    // Simulate process restart.
    const s2 = new OutgoingMessageStore({ dbPath });
    expect(s2.pendingCount("sess")).toBe(2);
    const batch = s2.dequeueBatch("sess", 10);
    expect(batch.map((r) => r.frame)).toEqual(["durable-A", "durable-B"]);
    s2.close();
  });

  it("isolates pending counts by clientId", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.enqueue("sess-A", "f1");
    s.enqueue("sess-A", "f2");
    s.enqueue("sess-B", "f3");

    expect(s.pendingCount("sess-A")).toBe(2);
    expect(s.pendingCount("sess-B")).toBe(1);
    expect(s.pendingCount("sess-C")).toBe(0);
    s.close();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("close() is idempotent — calling twice does not throw", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.close();
    expect(() => s.close()).not.toThrow();
    expect(s.isClosed).toBe(true);
  });

  it("enqueue after close() throws", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.close();
    expect(() => s.enqueue("sess", "x")).toThrow(/closed/);
  });

  it("dequeueBatch after close() throws", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.close();
    expect(() => s.dequeueBatch("sess", 10)).toThrow(/closed/);
  });

  it("pendingCount after close() throws", () => {
    const s = new OutgoingMessageStore({ dbPath });
    s.close();
    expect(() => s.pendingCount("sess")).toThrow(/closed/);
  });

  it("requires a dbPath in the constructor", () => {
    expect(() => new OutgoingMessageStore({ dbPath: "" })).toThrow(/dbPath is required/);
  });
});

describe("outgoingStorePath", () => {
  it("honors PRESTE_HOME when set", () => {
    const prev = process.env.PRESTE_HOME;
    process.env.PRESTE_HOME = "/tmp/sdk-test-home-out";
    try {
      expect(outgoingStorePath()).toBe("/tmp/sdk-test-home-out/outgoing.sqlite");
    } finally {
      if (prev === undefined) delete process.env.PRESTE_HOME;
      else process.env.PRESTE_HOME = prev;
    }
  });

  it("falls back to $HOME/.preste when PRESTE_HOME is unset", () => {
    const prev = process.env.PRESTE_HOME;
    delete process.env.PRESTE_HOME;
    try {
      const home = process.env.HOME ?? "/root";
      expect(outgoingStorePath()).toBe(`${home}/.preste/outgoing.sqlite`);
    } finally {
      if (prev !== undefined) process.env.PRESTE_HOME = prev;
    }
  });

  it("baseDir argument overrides PRESTE_HOME and $HOME/.preste entirely", () => {
    const prev = process.env.PRESTE_HOME;
    process.env.PRESTE_HOME = "/tmp/sdk-test-home-out";
    try {
      expect(outgoingStorePath("/custom/root")).toBe("/custom/root/outgoing.sqlite");
    } finally {
      if (prev === undefined) delete process.env.PRESTE_HOME;
      else process.env.PRESTE_HOME = prev;
    }
  });
});
