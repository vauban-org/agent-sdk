/**
 * Tests for packages/agent-sdk/src/orchestration/ooda/skills.ts
 *
 * Coverage:
 *   SecretNotFoundError — error identity, fields, message
 *   InMemorySecretsAccessor — get, has, accessedSecrets, defaults
 *   NOOP_SECRETS — exported constant
 *   EMPTY_SKILL_REGISTRY — exported constant
 *   createSkillContext — defaults, time accessors, clamped progress, executionId
 */

import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_SKILL_REGISTRY,
  InMemorySecretsAccessor,
  NOOP_SECRETS,
  SecretNotFoundError,
  createSkillContext,
} from "../src/orchestration/ooda/skills.js";
import type { LoggerPort } from "../src/ports/logger.js";
import type { DbClient } from "../src/tracking/agent-run-tracker.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fakeDb: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) };
const fakeLogger: LoggerPort = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ─── SecretNotFoundError ──────────────────────────────────────────────────────

describe("SecretNotFoundError", () => {
  it("is an instance of Error", () => {
    const err = new SecretNotFoundError("MY_KEY");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name SecretNotFoundError", () => {
    const err = new SecretNotFoundError("MY_KEY");
    expect(err.name).toBe("SecretNotFoundError");
  });

  it("exposes secretName field matching the requested key", () => {
    const err = new SecretNotFoundError("API_TOKEN");
    expect(err.secretName).toBe("API_TOKEN");
  });

  it("message contains the secret name", () => {
    const err = new SecretNotFoundError("DB_PASSWORD");
    expect(err.message).toContain("DB_PASSWORD");
  });

  it("can be caught as Error", () => {
    let caught: Error | undefined;
    try {
      throw new SecretNotFoundError("X");
    } catch (e) {
      if (e instanceof Error) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught!.name).toBe("SecretNotFoundError");
  });

  it("secretName survives a different key name", () => {
    const err = new SecretNotFoundError("SLACK_WEBHOOK_URL");
    expect(err.secretName).toBe("SLACK_WEBHOOK_URL");
    expect(err.message).toContain("SLACK_WEBHOOK_URL");
  });
});

// ─── InMemorySecretsAccessor ──────────────────────────────────────────────────

describe("InMemorySecretsAccessor", () => {
  // --- get: missing key, no default ---
  it("throws SecretNotFoundError when key is absent and no default provided", () => {
    const acc = new InMemorySecretsAccessor({});
    expect(() => acc.get("MISSING")).toThrow(SecretNotFoundError);
  });

  it("thrown error has the correct secretName when key is absent", () => {
    const acc = new InMemorySecretsAccessor({});
    try {
      acc.get("GONE");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretNotFoundError);
      expect((e as SecretNotFoundError).secretName).toBe("GONE");
    }
  });

  // --- get: missing key, with default ---
  it("returns defaultValue when key is absent and default is provided", () => {
    const acc = new InMemorySecretsAccessor({});
    expect(acc.get("MISSING", "fallback")).toBe("fallback");
  });

  it("returns empty string default when key is absent", () => {
    const acc = new InMemorySecretsAccessor({});
    expect(acc.get("MISSING", "")).toBe("");
  });

  // --- get: key present ---
  it("returns the stored value when key exists", () => {
    const acc = new InMemorySecretsAccessor({ MY_KEY: "my_value" });
    expect(acc.get("MY_KEY")).toBe("my_value");
  });

  it("returns stored value even when a default is also provided", () => {
    const acc = new InMemorySecretsAccessor({ KEY: "real" });
    expect(acc.get("KEY", "default")).toBe("real");
  });

  it("stored value of empty string is valid and returned", () => {
    const acc = new InMemorySecretsAccessor({ EMPTY_VAL: "" });
    expect(acc.get("EMPTY_VAL")).toBe("");
  });

  it("multiple secrets are independently accessible", () => {
    const acc = new InMemorySecretsAccessor({ A: "alpha", B: "beta" });
    expect(acc.get("A")).toBe("alpha");
    expect(acc.get("B")).toBe("beta");
  });

  // --- has ---
  it("has() returns true for an existing key", () => {
    const acc = new InMemorySecretsAccessor({ EXISTING: "yes" });
    expect(acc.has("EXISTING")).toBe(true);
  });

  it("has() returns false for a missing key", () => {
    const acc = new InMemorySecretsAccessor({ OTHER: "x" });
    expect(acc.has("MISSING")).toBe(false);
  });

  // --- accessedSecrets: get records ---
  it("get records the key in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({ K: "v" });
    acc.get("K");
    expect(acc.accessedSecrets.has("K")).toBe(true);
  });

  it("get with missing key + default still records in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({});
    acc.get("ABSENT", "default");
    expect(acc.accessedSecrets.has("ABSENT")).toBe(true);
  });

  it("get with missing key that throws still records in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({});
    try {
      acc.get("THROWN_KEY");
    } catch {
      // expected
    }
    expect(acc.accessedSecrets.has("THROWN_KEY")).toBe(true);
  });

  // --- accessedSecrets: has records ---
  it("has() records the key in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({ Z: "z" });
    acc.has("Z");
    expect(acc.accessedSecrets.has("Z")).toBe(true);
  });

  it("has() for missing key records in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({});
    acc.has("NOT_THERE");
    expect(acc.accessedSecrets.has("NOT_THERE")).toBe(true);
  });

  // --- accessedSecrets: accumulation ---
  it("multiple get calls accumulate distinct keys in accessedSecrets", () => {
    const acc = new InMemorySecretsAccessor({ X: "1", Y: "2" });
    acc.get("X");
    acc.get("Y");
    expect(acc.accessedSecrets.has("X")).toBe(true);
    expect(acc.accessedSecrets.has("Y")).toBe(true);
    expect(acc.accessedSecrets.size).toBe(2);
  });

  it("calling get twice with the same name deduplicates in accessedSecrets (Set semantics)", () => {
    const acc = new InMemorySecretsAccessor({ DUP: "val" });
    acc.get("DUP");
    acc.get("DUP");
    expect(acc.accessedSecrets.size).toBe(1);
  });

  it("has then get for the same key keeps size at 1", () => {
    const acc = new InMemorySecretsAccessor({ SAME: "v" });
    acc.has("SAME");
    acc.get("SAME");
    expect(acc.accessedSecrets.size).toBe(1);
  });

  // --- accessedSecrets: ReadonlySet ---
  it("accessedSecrets is a ReadonlySet (no add/delete/clear methods exposed via the interface)", () => {
    const acc = new InMemorySecretsAccessor({});
    const s = acc.accessedSecrets;
    // ReadonlySet has has/forEach/values but no add/delete
    expect(typeof s.has).toBe("function");
    expect(typeof (s as Set<string>).add).toBe("function"); // underlying Set still has it but type hides it
    expect(s.size).toBe(0);
  });

  // --- default constructor (no args) ---
  it("default empty constructor throws for any key get", () => {
    const acc = new InMemorySecretsAccessor();
    expect(() => acc.get("ANYTHING")).toThrow(SecretNotFoundError);
  });

  it("default empty constructor has() returns false", () => {
    const acc = new InMemorySecretsAccessor();
    expect(acc.has("ANYTHING")).toBe(false);
  });

  // --- SecretNotFoundError thrown even when other secrets exist ---
  it("throws SecretNotFoundError for an absent key even when other keys are present", () => {
    const acc = new InMemorySecretsAccessor({ PRESENT: "yes" });
    expect(() => acc.get("ABSENT")).toThrow(SecretNotFoundError);
    expect(acc.get("PRESENT")).toBe("yes");
  });
});

// ─── NOOP_SECRETS ─────────────────────────────────────────────────────────────

describe("NOOP_SECRETS", () => {
  it("is an instance of InMemorySecretsAccessor", () => {
    expect(NOOP_SECRETS).toBeInstanceOf(InMemorySecretsAccessor);
  });

  it("has() always returns false", () => {
    expect(NOOP_SECRETS.has("ANYTHING")).toBe(false);
  });

  it("get with default returns the default", () => {
    expect(NOOP_SECRETS.get("ANYTHING", "fallback")).toBe("fallback");
  });

  it("get without default throws SecretNotFoundError", () => {
    // Each test call accumulates but that is fine for a module-level constant
    expect(() => NOOP_SECRETS.get("ANYTHING")).toThrow(SecretNotFoundError);
  });
});

// ─── EMPTY_SKILL_REGISTRY ─────────────────────────────────────────────────────

describe("EMPTY_SKILL_REGISTRY", () => {
  it("is an empty frozen object", () => {
    expect(Object.keys(EMPTY_SKILL_REGISTRY)).toHaveLength(0);
    expect(Object.isFrozen(EMPTY_SKILL_REGISTRY)).toBe(true);
  });

  it("has no enumerable properties", () => {
    expect(Object.keys(EMPTY_SKILL_REGISTRY).length).toBe(0);
  });
});

// ─── createSkillContext ────────────────────────────────────────────────────────

describe("createSkillContext", () => {
  it("sets isReplay to false by default", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.isReplay).toBe(false);
  });

  it("propagates isReplay: true when provided", () => {
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      isReplay: true,
    });
    expect(ctx.isReplay).toBe(true);
  });

  it("dryRunMocks defaults to empty object", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.dryRunMocks).toEqual({});
  });

  it("propagates custom dryRunMocks", () => {
    const mocks = { mySkill: () => "mocked" };
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      dryRunMocks: mocks,
    });
    expect(ctx.dryRunMocks).toBe(mocks);
  });

  it("secrets defaults to NOOP_SECRETS when not provided", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.secrets).toBe(NOOP_SECRETS);
  });

  it("propagates a custom SecretsAccessor", () => {
    const acc = new InMemorySecretsAccessor({ TOKEN: "tok" });
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      secrets: acc,
    });
    expect(ctx.secrets).toBe(acc);
    expect(ctx.secrets!.get("TOKEN")).toBe("tok");
  });

  it("elapsedSeconds returns a non-negative number", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it("remainingSeconds returns +Infinity when no timeout configured", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.remainingSeconds).toBe(Number.POSITIVE_INFINITY);
  });

  it("remainingSeconds decreases with time when timeout is set", async () => {
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      timeoutSeconds: 10,
    });
    const r1 = ctx.remainingSeconds!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const r2 = ctx.remainingSeconds!;
    expect(r2).toBeLessThanOrEqual(r1);
  });

  it("executionId is attached when provided", () => {
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      executionId: "exec-001",
    });
    expect(ctx.executionId).toBe("exec-001");
  });

  it("executionId is absent when not provided", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.executionId).toBeUndefined();
  });

  it("progress callback clamps value above 1 to 1", () => {
    const calls: number[] = [];
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      progress: (v) => calls.push(v),
    });
    ctx.progress!(1.5);
    expect(calls[0]).toBe(1);
  });

  it("progress callback clamps value below 0 to 0", () => {
    const calls: number[] = [];
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      progress: (v) => calls.push(v),
    });
    ctx.progress!(-0.5);
    expect(calls[0]).toBe(0);
  });

  it("progress callback clamps non-finite value to 0", () => {
    const calls: number[] = [];
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      progress: (v) => calls.push(v),
    });
    ctx.progress!(Number.NaN);
    expect(calls[0]).toBe(0);
  });

  it("progress callback passes a valid value unchanged", () => {
    const calls: number[] = [];
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      progress: (v) => calls.push(v),
    });
    ctx.progress!(0.5);
    expect(calls[0]).toBe(0.5);
  });

  it("progress is a noop when not provided (no throw)", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(() => ctx.progress!(0.5)).not.toThrow();
  });

  it("respects a custom startedAt for elapsed computation", async () => {
    const pastDate = new Date(Date.now() - 2000);
    const ctx = createSkillContext({
      db: fakeDb,
      logger: fakeLogger,
      startedAt: pastDate,
    });
    expect(ctx.elapsedSeconds!).toBeGreaterThanOrEqual(1.9);
  });

  it("db is forwarded as-is", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.db).toBe(fakeDb);
  });

  it("logger is forwarded as-is", () => {
    const ctx = createSkillContext({ db: fakeDb, logger: fakeLogger });
    expect(ctx.logger).toBe(fakeLogger);
  });
});
