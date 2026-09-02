/**
 * Tests for agent-sdk/src/skills/_secrets.ts + base-skills.ts
 *
 * Coverage (_secrets):
 *   readSecret — prefers ctx.secrets over process.env,
 *                falls back to process.env when ctx.secrets absent/miss,
 *                returns undefined when configured nowhere
 *
 * Coverage (base-skills):
 *   BASE_SKILL_NAMES — contains the 4 expected skill names
 *
 * Ref: test coverage for skills/_secrets.ts + base-skills.ts (no prior tests)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSecret } from "../src/skills/_secrets.js";
import { BASE_SKILL_NAMES } from "../src/skills/base-skills.js";

// ─── readSecret ───────────────────────────────────────────────────────────────

describe("readSecret", () => {
  beforeEach(() => delete process.env.MY_SECRET);
  afterEach(() => delete process.env.MY_SECRET);

  it("returns value from ctx.secrets when present", () => {
    const ctx = {
      secrets: new Map([["MY_SECRET", "from-ctx"]]),
    } as never;
    process.env.MY_SECRET = "from-env"; // should be ignored
    const result = readSecret(ctx, "MY_SECRET");
    expect(result).toBe("from-ctx");
  });

  it("falls back to process.env when ctx.secrets does not have the key", () => {
    const ctx = {
      secrets: new Map([["OTHER_KEY", "val"]]),
    } as never;
    process.env.MY_SECRET = "env-value";
    const result = readSecret(ctx, "MY_SECRET");
    expect(result).toBe("env-value");
  });

  it("falls back to process.env when ctx.secrets is undefined", () => {
    const ctx = {} as never;
    process.env.MY_SECRET = "fallback";
    expect(readSecret(ctx, "MY_SECRET")).toBe("fallback");
  });

  it("returns undefined when secret is configured nowhere", () => {
    const ctx = {} as never;
    expect(readSecret(ctx, "MY_SECRET")).toBeUndefined();
  });

  it("returns undefined from ctx.secrets when value is undefined", () => {
    const secrets = new Map<string, string | undefined>([["MY_SECRET", undefined]]);
    const ctx = { secrets } as never;
    // Map.has() returns true, but Map.get() returns undefined
    // ctx.secrets.has(name) = true → returns undefined from secrets
    expect(readSecret(ctx, "MY_SECRET")).toBeUndefined();
  });
});

// ─── BASE_SKILL_NAMES ────────────────────────────────────────────────────────

describe("BASE_SKILL_NAMES", () => {
  it("contains brain-query", () => {
    expect(BASE_SKILL_NAMES).toContain("brain-query");
  });

  it("contains brain-store", () => {
    expect(BASE_SKILL_NAMES).toContain("brain-store");
  });

  it("contains slack-notify", () => {
    expect(BASE_SKILL_NAMES).toContain("slack-notify");
  });

  it("contains llm-complete", () => {
    expect(BASE_SKILL_NAMES).toContain("llm-complete");
  });

  it("has exactly 4 entries", () => {
    expect(BASE_SKILL_NAMES).toHaveLength(4);
  });
});
