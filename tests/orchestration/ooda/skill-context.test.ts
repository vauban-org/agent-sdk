import { describe, expect, it, vi } from "vitest";

import {
  InMemorySecretsAccessor,
  NOOP_SECRETS,
  SecretNotFoundError,
  type SkillContext,
  createSkillContext,
} from "../../../src/orchestration/ooda/skills.js";

// Minimal stubs for required ports — tests don't exercise them.
const stubDb = {
  query: async () => ({ rows: [] }),
} as unknown as SkillContext["db"];

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as SkillContext["logger"];

describe("InMemorySecretsAccessor", () => {
  it("returns configured secret and records access", () => {
    const accessor = new InMemorySecretsAccessor({ API_KEY: "secret-1" });
    expect(accessor.get("API_KEY")).toBe("secret-1");
    expect(accessor.accessedSecrets.has("API_KEY")).toBe(true);
  });

  it("returns default value when secret is missing", () => {
    const accessor = new InMemorySecretsAccessor();
    expect(accessor.get("MISSING", "fallback")).toBe("fallback");
    expect(accessor.accessedSecrets.has("MISSING")).toBe(true);
  });

  it("throws SecretNotFoundError when missing and no default", () => {
    const accessor = new InMemorySecretsAccessor();
    expect(() => accessor.get("ABSENT")).toThrow(SecretNotFoundError);
    expect(accessor.accessedSecrets.has("ABSENT")).toBe(true);
  });

  it("has() returns boolean and records access", () => {
    const accessor = new InMemorySecretsAccessor({ X: "y" });
    expect(accessor.has("X")).toBe(true);
    expect(accessor.has("Y")).toBe(false);
    expect(accessor.accessedSecrets.has("X")).toBe(true);
    expect(accessor.accessedSecrets.has("Y")).toBe(true);
  });

  it("audit set accumulates across calls", () => {
    const accessor = new InMemorySecretsAccessor({ A: "1", B: "2", C: "3" });
    accessor.get("A");
    accessor.has("B");
    accessor.get("D", "default-d");
    expect(Array.from(accessor.accessedSecrets).sort()).toEqual(["A", "B", "D"]);
  });

  it("NOOP_SECRETS does not return any secret", () => {
    expect(NOOP_SECRETS.has("ANY")).toBe(false);
    expect(() => NOOP_SECRETS.get("ANY")).toThrow(SecretNotFoundError);
  });
});

describe("createSkillContext", () => {
  it("populates defaults for all optional fields", () => {
    const ctx = createSkillContext({ db: stubDb, logger: stubLogger });
    expect(ctx.isReplay).toBe(false);
    expect(ctx.dryRunMocks).toEqual({});
    expect(ctx.secrets).toBeDefined();
    expect(typeof ctx.progress).toBe("function");
    expect(ctx.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(ctx.remainingSeconds).toBe(Number.POSITIVE_INFINITY);
  });

  it("exposes executionId when provided", () => {
    const ctx = createSkillContext({
      db: stubDb,
      logger: stubLogger,
      executionId: "exec-7",
    });
    expect(ctx.executionId).toBe("exec-7");
  });

  it("omits executionId entirely when not provided", () => {
    const ctx = createSkillContext({ db: stubDb, logger: stubLogger });
    expect(ctx.executionId).toBeUndefined();
  });

  it("progress callback clamps to [0,1] and forwards to caller", () => {
    const observed: Array<{ value: number; message: string | undefined }> = [];
    const ctx = createSkillContext({
      db: stubDb,
      logger: stubLogger,
      progress: (value, message) => observed.push({ value, message }),
    });

    ctx.progress?.(0.5, "halfway");
    ctx.progress?.(-0.5);
    ctx.progress?.(1.5);
    ctx.progress?.(Number.NaN);

    expect(observed).toEqual([
      { value: 0.5, message: "halfway" },
      { value: 0, message: undefined },
      { value: 1, message: undefined },
      { value: 0, message: undefined },
    ]);
  });

  it("elapsedSeconds is live (recomputed on each read)", async () => {
    const ctx = createSkillContext({ db: stubDb, logger: stubLogger });
    const t0 = ctx.elapsedSeconds!;
    await new Promise((r) => setTimeout(r, 15));
    const t1 = ctx.elapsedSeconds!;
    expect(t1).toBeGreaterThan(t0);
  });

  it("remainingSeconds decreases over time when timeoutSeconds is finite", async () => {
    const ctx = createSkillContext({
      db: stubDb,
      logger: stubLogger,
      timeoutSeconds: 1.0,
    });
    const r0 = ctx.remainingSeconds!;
    await new Promise((r) => setTimeout(r, 30));
    const r1 = ctx.remainingSeconds!;
    expect(r1).toBeLessThan(r0);
    expect(r1).toBeGreaterThanOrEqual(0);
  });

  it("remainingSeconds is infinity when no timeout configured", () => {
    const ctx = createSkillContext({ db: stubDb, logger: stubLogger });
    expect(ctx.remainingSeconds).toBe(Number.POSITIVE_INFINITY);
  });

  it("uses caller-provided secrets accessor", () => {
    const accessor = new InMemorySecretsAccessor({ K: "v" });
    const ctx = createSkillContext({
      db: stubDb,
      logger: stubLogger,
      secrets: accessor,
    });
    expect(ctx.secrets?.get("K")).toBe("v");
    expect(ctx.secrets?.accessedSecrets.has("K")).toBe(true);
  });

  it("uses caller-provided startedAt for elapsed/remaining math", () => {
    const startedAt = new Date(Date.now() - 5_000); // 5s ago
    const ctx = createSkillContext({
      db: stubDb,
      logger: stubLogger,
      startedAt,
      timeoutSeconds: 10,
    });
    expect(ctx.elapsedSeconds).toBeGreaterThanOrEqual(5);
    expect(ctx.remainingSeconds).toBeLessThanOrEqual(5);
  });
});

describe("SkillContext backwards compatibility", () => {
  it("a context with ONLY the legacy 4 fields satisfies SkillContext", () => {
    const legacy: SkillContext = {
      isReplay: false,
      dryRunMocks: {},
      db: stubDb,
      logger: stubLogger,
    };
    expect(legacy.executionId).toBeUndefined();
    expect(legacy.secrets).toBeUndefined();
    expect(legacy.progress).toBeUndefined();
    expect(legacy.elapsedSeconds).toBeUndefined();
    expect(legacy.remainingSeconds).toBeUndefined();
  });

  it("a skill that does not touch optional fields runs unchanged", async () => {
    const legacyCtx: SkillContext = {
      isReplay: false,
      dryRunMocks: {},
      db: stubDb,
      logger: stubLogger,
    };
    // Simulate a skill execution that ignores the new fields.
    const skillRun = vi.fn(async (ctx: SkillContext) => {
      return { replay: ctx.isReplay };
    });
    const result = await skillRun(legacyCtx);
    expect(result).toEqual({ replay: false });
  });
});
