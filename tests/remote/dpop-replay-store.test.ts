/**
 * Boundary tests for `DpopReplayStore` (P1b).
 *
 * The sibling `dpop.test.ts` covers the basic happy + eviction path.
 * This file pins down the boundary conditions that future Redis / SQLite
 * implementations must also satisfy : insertion-order eviction, batch
 * overflow, exact-equality TTL boundary, capacity-of-1, idempotent
 * record, and pathological inputs (empty jti, long jti).
 *
 * The store's contract — "isReplayed(jti) returns true iff jti has been
 * recorded with an expiry strictly in the future" — is small enough that
 * we can fence in every edge case.
 *
 * @since 2.24.0 — preste P1b
 */

import { describe, expect, it } from "vitest";
import { DpopReplayStore } from "../../src/remote/index.js";

describe("DpopReplayStore — capacity boundary", () => {
  it("evicts in insertion order (oldest jti goes first)", () => {
    const s = new DpopReplayStore({ maxSize: 4 });
    const now = Date.now();
    s.record("first", now + 60_000);
    s.record("second", now + 60_000);
    s.record("third", now + 60_000);
    s.record("fourth", now + 60_000);
    s.record("fifth", now + 60_000); // overflows — drops "first"
    expect(s.isReplayed("first", now)).toBe(false);
    expect(s.isReplayed("second", now)).toBe(true);
    expect(s.isReplayed("fifth", now)).toBe(true);
    expect(s.size).toBe(4);
  });

  it("evicts only one entry per overflowing record", () => {
    const s = new DpopReplayStore({ maxSize: 3 });
    const now = Date.now();
    for (const k of ["a", "b", "c", "d", "e"]) {
      s.record(k, now + 60_000);
    }
    // After 5 records into a 3-slot store : a + b evicted, c/d/e remain.
    expect(s.isReplayed("a", now)).toBe(false);
    expect(s.isReplayed("b", now)).toBe(false);
    expect(s.isReplayed("c", now)).toBe(true);
    expect(s.isReplayed("d", now)).toBe(true);
    expect(s.isReplayed("e", now)).toBe(true);
    expect(s.size).toBe(3);
  });

  it("capacity of 1 — every new record evicts the previous", () => {
    const s = new DpopReplayStore({ maxSize: 1 });
    const now = Date.now();
    s.record("alpha", now + 60_000);
    expect(s.isReplayed("alpha", now)).toBe(true);
    s.record("beta", now + 60_000);
    expect(s.isReplayed("alpha", now)).toBe(false);
    expect(s.isReplayed("beta", now)).toBe(true);
    expect(s.size).toBe(1);
  });

  it("default capacity is 10_000 — record beyond it triggers eviction", () => {
    const s = new DpopReplayStore(); // default = 10_000
    const now = Date.now();
    // Fill exactly to capacity ; nothing should have been evicted yet.
    for (let i = 0; i < 10_000; i++) {
      s.record(`jti-${i}`, now + 60_000);
    }
    expect(s.size).toBe(10_000);
    expect(s.isReplayed("jti-0", now)).toBe(true);
    // One more pushes us over — oldest is evicted.
    s.record("overflow", now + 60_000);
    expect(s.isReplayed("jti-0", now)).toBe(false);
    expect(s.size).toBe(10_000);
  });
});

describe("DpopReplayStore — TTL boundary", () => {
  it("treats expiry exactly equal to now as already-expired", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    // The contract is `expiresAtMs > nowMs`. Equality → expired.
    s.record("edge", now);
    expect(s.isReplayed("edge", now)).toBe(false);
  });

  it("expiry one ms past now still counts as replayed", () => {
    const s = new DpopReplayStore();
    const now = 1_000_000_000;
    s.record("almost-cold", now + 1);
    expect(s.isReplayed("almost-cold", now)).toBe(true);
  });

  it("GC removes expired entries on every record() call", () => {
    const s = new DpopReplayStore();
    s.record("cold-1", 1);
    s.record("cold-2", 2);
    // Trigger GC by recording a fresh entry — the cold ones are dropped.
    s.record("hot", Date.now() + 60_000);
    expect(s.size).toBe(1);
  });

  it("GC removes expired entries on isReplayed() check", () => {
    const s = new DpopReplayStore();
    s.record("expired-now", 1);
    expect(s.size).toBe(1);
    // Any isReplayed call triggers the gc sweep.
    s.isReplayed("anything-else", Date.now());
    expect(s.size).toBe(0);
  });

  it("GC drops stale entries but preserves the live ones around them", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    // The 2nd record() GCs the already-stale entry before insertion ;
    // the fresh entry survives untouched.
    s.record("stale", now - 10_000);
    s.record("fresh", now + 60_000);
    expect(s.size).toBe(1);
    expect(s.isReplayed("fresh", now)).toBe(true);
    expect(s.isReplayed("stale", now)).toBe(false);
  });
});

describe("DpopReplayStore — idempotence + reset", () => {
  it("record() with the same jti overwrites the expiry (no double-insert)", () => {
    const s = new DpopReplayStore({ maxSize: 2 });
    const now = Date.now();
    s.record("dup", now + 1000);
    s.record("dup", now + 60_000); // overwrite — still 1 entry.
    s.record("other", now + 60_000);
    expect(s.size).toBe(2);
    expect(s.isReplayed("dup", now)).toBe(true);
    expect(s.isReplayed("other", now)).toBe(true);
  });

  it("reset() leaves the store usable for fresh records", () => {
    const s = new DpopReplayStore({ maxSize: 5 });
    s.record("pre-reset", Date.now() + 60_000);
    s.reset();
    expect(s.size).toBe(0);
    s.record("post-reset", Date.now() + 60_000);
    expect(s.size).toBe(1);
    expect(s.isReplayed("post-reset")).toBe(true);
  });

  it("multiple reset() calls are safe", () => {
    const s = new DpopReplayStore();
    s.record("a", Date.now() + 60_000);
    s.reset();
    s.reset();
    s.reset();
    expect(s.size).toBe(0);
  });
});

describe("DpopReplayStore — pathological inputs", () => {
  it("handles empty-string jti (still distinct from unrecorded)", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    expect(s.isReplayed("", now)).toBe(false);
    s.record("", now + 60_000);
    expect(s.isReplayed("", now)).toBe(true);
  });

  it("handles very long jti without truncation", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    const long = "x".repeat(4096);
    s.record(long, now + 60_000);
    expect(s.isReplayed(long, now)).toBe(true);
    expect(s.isReplayed("x".repeat(4095), now)).toBe(false);
  });

  it("isReplayed uses Date.now() by default when nowMs is omitted", () => {
    const s = new DpopReplayStore();
    s.record("now-default", Date.now() + 60_000);
    expect(s.isReplayed("now-default")).toBe(true);
  });

  it("distinguishes jtis case-sensitively", () => {
    const s = new DpopReplayStore();
    const now = Date.now();
    s.record("CaseSensitive", now + 60_000);
    expect(s.isReplayed("CaseSensitive", now)).toBe(true);
    expect(s.isReplayed("casesensitive", now)).toBe(false);
  });
});
