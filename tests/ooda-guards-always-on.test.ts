/**
 * Tests for always-on SessionGuard.
 *
 * Verifies the guard returns the expected shape and always resolves to true
 * regardless of the date passed.
 *
 * Ref: ooda/guards/always-on.ts
 */

import { describe, expect, it } from "vitest";
import { alwaysOn } from "../src/orchestration/ooda/guards/always-on.js";

describe("alwaysOn — shape", () => {
  it("returns an object (SessionGuard)", () => {
    const guard = alwaysOn();
    expect(guard).toBeDefined();
    expect(typeof guard).toBe("object");
    expect(guard).not.toBeNull();
  });

  it("has a name property", () => {
    const guard = alwaysOn();
    expect("name" in guard).toBe(true);
  });

  it("name === 'always-on'", () => {
    const guard = alwaysOn();
    expect(guard.name).toBe("always-on");
  });

  it("has an isActive property", () => {
    const guard = alwaysOn();
    expect("isActive" in guard).toBe(true);
  });

  it("isActive is a function", () => {
    const guard = alwaysOn();
    expect(typeof guard.isActive).toBe("function");
  });

  it("isActive returns a Promise", () => {
    const guard = alwaysOn();
    const result = guard.isActive(new Date());
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("alwaysOn — isActive always resolves to true", () => {
  it("resolves to true at any time (now)", async () => {
    const guard = alwaysOn();
    const result = await guard.isActive(new Date());
    expect(result).toBe(true);
  });

  it("resolves to true on a weekend date (2024-01-06 Saturday)", async () => {
    const guard = alwaysOn();
    const saturday = new Date("2024-01-06T12:00:00Z");
    expect(await guard.isActive(saturday)).toBe(true);
  });

  it("resolves to true at midnight (start of day)", async () => {
    const guard = alwaysOn();
    const midnight = new Date("2024-06-15T00:00:00Z");
    expect(await guard.isActive(midnight)).toBe(true);
  });

  it("multiple consecutive calls all return true", async () => {
    const guard = alwaysOn();
    const now = new Date();
    const results = await Promise.all([
      guard.isActive(now),
      guard.isActive(now),
      guard.isActive(now),
    ]);
    expect(results).toEqual([true, true, true]);
  });

  it("different dates (past, present, future) all return true", async () => {
    const guard = alwaysOn();
    const past = new Date(0); // 1970-01-01
    const present = new Date();
    const future = new Date("2099-12-31T23:59:59Z");

    expect(await guard.isActive(past)).toBe(true);
    expect(await guard.isActive(present)).toBe(true);
    expect(await guard.isActive(future)).toBe(true);
  });

  it("result is exactly true (not just truthy)", async () => {
    const guard = alwaysOn();
    const result = await guard.isActive(new Date());
    // Strict equality — not 1, not 'yes', not any truthy value
    expect(result).toStrictEqual(true);
  });
});

describe("alwaysOn — factory creates independent instances", () => {
  it("each call to alwaysOn() returns a new object", () => {
    const g1 = alwaysOn();
    const g2 = alwaysOn();
    expect(g1).not.toBe(g2);
  });

  it("both instances have the same name", () => {
    expect(alwaysOn().name).toBe(alwaysOn().name);
  });
});
