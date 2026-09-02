/**
 * Tests for ClockPort implementations.
 *
 * Coverage:
 *   - RealClock.now() returns a recent timestamp.
 *   - RecordedClock returns recorded timestamps in order.
 *   - RecordedClock throws ClockExhaustedError when cursor exceeds recorded length.
 *   - reset() resets cursor to zero.
 */

import { describe, expect, it } from "vitest";
import { ClockExhaustedError, RealClock, RecordedClock } from "../src/replay/clock.js";

describe("RealClock", () => {
  it("now() returns a recent Unix epoch millisecond timestamp", () => {
    const clock = new RealClock();
    const before = Date.now();
    const ts = clock.now();
    const after = Date.now();

    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("now() returns a number greater than a known past epoch (2020-01-01)", () => {
    const clock = new RealClock();
    // 2020-01-01T00:00:00.000Z
    expect(clock.now()).toBeGreaterThan(1577836800000);
  });
});

describe("RecordedClock", () => {
  it("returns recorded timestamps in order", () => {
    const timestamps = [1000, 2000, 3000];
    const clock = new RecordedClock(timestamps);

    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(2000);
    expect(clock.now()).toBe(3000);
  });

  it("getCursor() tracks the number of consumed timestamps", () => {
    const clock = new RecordedClock([100, 200, 300]);

    expect(clock.getCursor()).toBe(0);
    clock.now();
    expect(clock.getCursor()).toBe(1);
    clock.now();
    expect(clock.getCursor()).toBe(2);
  });

  it("throws ClockExhaustedError when all timestamps are consumed", () => {
    const clock = new RecordedClock([42]);
    clock.now(); // consumes the only timestamp

    expect(() => clock.now()).toThrow(ClockExhaustedError);
  });

  it("ClockExhaustedError message contains recorded count and requested index", () => {
    const clock = new RecordedClock([1, 2]);
    clock.now();
    clock.now();

    let err: ClockExhaustedError | undefined;
    try {
      clock.now();
    } catch (e) {
      err = e as ClockExhaustedError;
    }

    expect(err).toBeInstanceOf(ClockExhaustedError);
    expect(err?.message).toContain("2"); // recorded count
    expect(err?.message).toContain("3"); // requested + 1
    expect(err?.name).toBe("ClockExhaustedError");
  });

  it("throws ClockExhaustedError immediately for empty recorded array", () => {
    const clock = new RecordedClock([]);
    expect(() => clock.now()).toThrow(ClockExhaustedError);
  });

  it("reset() resets cursor to zero", () => {
    const timestamps = [10, 20, 30];
    const clock = new RecordedClock(timestamps);

    expect(clock.now()).toBe(10);
    expect(clock.now()).toBe(20);
    clock.reset();
    expect(clock.getCursor()).toBe(0);
    expect(clock.now()).toBe(10); // replays from the start
  });

  it("reset() allows full replay multiple times", () => {
    const timestamps = [100, 200];
    const clock = new RecordedClock(timestamps);

    // First pass
    expect(clock.now()).toBe(100);
    expect(clock.now()).toBe(200);

    // Reset and second pass
    clock.reset();
    expect(clock.now()).toBe(100);
    expect(clock.now()).toBe(200);
  });
});
