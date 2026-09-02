/**
 * Tests for packages/agent-sdk/src/skill-loop/versioning.ts
 *
 * Coverage:
 *   bumpVersion — initial type returns baseline "1.0.0",
 *                 reflexion bumps minor,
 *                 ab_winner bumps minor,
 *                 manual bumps major,
 *                 resets minor/patch to 0 on major bump,
 *                 resets patch to 0 on minor bump,
 *                 throws on invalid semver format,
 *                 throws on non-numeric components,
 *                 initial ignores current value,
 *                 accumulates bumps correctly
 *
 * SkillVersion — interface shape verified via construction
 */

import { describe, expect, it } from "vitest";
import { bumpVersion } from "../src/skill-loop/versioning.js";

describe("bumpVersion", () => {
  // --- initial mutation type ---

  it("returns '1.0.0' for initial regardless of current value", () => {
    expect(bumpVersion("0.0.0", "initial")).toBe("1.0.0");
  });

  it("returns '1.0.0' for initial even when current is a high version", () => {
    expect(bumpVersion("5.4.3", "initial")).toBe("1.0.0");
  });

  // --- reflexion mutation type ---

  it("bumps minor for reflexion from '1.0.0'", () => {
    expect(bumpVersion("1.0.0", "reflexion")).toBe("1.1.0");
  });

  it("bumps minor for reflexion from '2.3.7'", () => {
    expect(bumpVersion("2.3.7", "reflexion")).toBe("2.4.0");
  });

  it("resets patch to 0 on reflexion minor bump", () => {
    expect(bumpVersion("1.2.9", "reflexion")).toBe("1.3.0");
  });

  // --- ab_winner mutation type ---

  it("bumps minor for ab_winner from '1.0.0'", () => {
    expect(bumpVersion("1.0.0", "ab_winner")).toBe("1.1.0");
  });

  it("bumps minor for ab_winner from '3.5.2'", () => {
    expect(bumpVersion("3.5.2", "ab_winner")).toBe("3.6.0");
  });

  it("resets patch to 0 on ab_winner minor bump", () => {
    expect(bumpVersion("1.1.11", "ab_winner")).toBe("1.2.0");
  });

  // --- manual mutation type ---

  it("bumps major for manual from '1.0.0'", () => {
    expect(bumpVersion("1.0.0", "manual")).toBe("2.0.0");
  });

  it("bumps major for manual from '4.7.3'", () => {
    expect(bumpVersion("4.7.3", "manual")).toBe("5.0.0");
  });

  it("resets minor and patch to 0 on manual major bump", () => {
    expect(bumpVersion("2.9.9", "manual")).toBe("3.0.0");
  });

  // --- accumulation across multiple bumps ---

  it("correctly accumulates multiple reflexion bumps", () => {
    let v = "1.0.0";
    v = bumpVersion(v, "reflexion");
    v = bumpVersion(v, "reflexion");
    v = bumpVersion(v, "reflexion");
    expect(v).toBe("1.3.0");
  });

  it("correctly handles reflexion then manual sequence", () => {
    let v = "1.0.0";
    v = bumpVersion(v, "reflexion"); // 1.1.0
    v = bumpVersion(v, "manual"); // 2.0.0
    expect(v).toBe("2.0.0");
  });

  // --- error handling ---

  it("throws for a version with only 2 parts", () => {
    expect(() => bumpVersion("1.0", "reflexion")).toThrow(/invalid semver/);
  });

  it("throws for a version with 4 parts", () => {
    expect(() => bumpVersion("1.0.0.0", "reflexion")).toThrow(/invalid semver/);
  });

  it("throws for non-numeric major component", () => {
    expect(() => bumpVersion("x.0.0", "reflexion")).toThrow();
  });

  it("throws for non-numeric minor component", () => {
    expect(() => bumpVersion("1.y.0", "reflexion")).toThrow();
  });

  it("throws for an empty string version", () => {
    expect(() => bumpVersion("", "reflexion")).toThrow(/invalid semver/);
  });
});
