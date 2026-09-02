/**
 * tests/ports-remaining.test.ts
 *
 * Unit tests for:
 *   - packages/agent-sdk/src/ports/price.ts          (interface shapes)
 *   - packages/agent-sdk/src/ports/db.ts             (error classes, createTracedDbPort)
 *   - packages/agent-sdk/src/verify/formal/result.ts (type/interface shapes)
 *   - packages/agent-sdk/src/verify/formal/solver.ts (checkSmt, isZ3Available, cache reset)
 *   - packages/agent-sdk/src/registry/agent-capability.ts (AGENT_KINDS, card shape)
 *   - packages/agent-sdk/src/skill-manifest/anchor.ts (anchorWithTsa fail-closed, parseTsaToken, verifyTsaAnchor)
 */

import { afterEach, describe, expect, it } from "vitest";

// ─── ports/db.ts ──────────────────────────────────────────────────────────────

import { DbConnectionLostError, DbQueryTimeoutError, createTracedDbPort } from "../src/ports/db.js";

// ─── verify/formal/solver.ts ──────────────────────────────────────────────────

import {
  __resetZ3AvailabilityCache,
  checkSmt,
  isZ3Available,
} from "../src/verify/formal/solver.js";

// ─── registry/agent-capability.ts ────────────────────────────────────────────

import {
  AGENT_KINDS,
  type AgentCapabilityCard,
  type AgentKind,
} from "../src/registry/agent-capability.js";

// ─── skill-manifest/anchor.ts ─────────────────────────────────────────────────

import {
  TsaUnavailableError,
  anchorWithTsa,
  parseTsaToken,
  verifyTsaAnchor,
} from "../src/skill-manifest/anchor.js";
import type { SkillManifest } from "../src/skill-manifest/types.js";

/**
 * Test-only helper: builds the documented "MOCK_TSA:<hash>:<isoTimestamp>"
 * degraded-grade format directly. anchorWithTsa() itself never produces this
 * (fail-closed ; throws TsaUnavailableError instead of fabricating).
 */
function buildMockTsaTokenForTest(manifestHash: string, ts: Date = new Date()): string {
  return Buffer.from(`MOCK_TSA:${manifestHash}:${ts.toISOString()}`, "utf8").toString("base64");
}

// =============================================================================
// ports/db.ts — DbConnectionLostError
// =============================================================================

describe("DbConnectionLostError", () => {
  it("is an instance of Error", () => {
    const err = new DbConnectionLostError("connection refused");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of DbConnectionLostError", () => {
    const err = new DbConnectionLostError("pool exhausted");
    expect(err).toBeInstanceOf(DbConnectionLostError);
  });

  it("sets .name to DbConnectionLostError", () => {
    const err = new DbConnectionLostError("tls handshake failed");
    expect(err.name).toBe("DbConnectionLostError");
  });

  it("preserves message", () => {
    const err = new DbConnectionLostError("ECONNREFUSED 5432");
    expect(err.message).toBe("ECONNREFUSED 5432");
  });

  it("stores optional cause", () => {
    const cause = new Error("original");
    const err = new DbConnectionLostError("wrapper", cause);
    expect(err.cause).toBe(cause);
  });

  it("has undefined cause when not provided", () => {
    const err = new DbConnectionLostError("no cause");
    expect(err.cause).toBeUndefined();
  });
});

// =============================================================================
// ports/db.ts — DbQueryTimeoutError
// =============================================================================

describe("DbQueryTimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new DbQueryTimeoutError("timeout", "SELECT 1", 3000);
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of DbQueryTimeoutError", () => {
    const err = new DbQueryTimeoutError("timeout", "SELECT 1", 3000);
    expect(err).toBeInstanceOf(DbQueryTimeoutError);
  });

  it("sets .name to DbQueryTimeoutError", () => {
    const err = new DbQueryTimeoutError("exceeded", "SELECT count(*) FROM t", 1000);
    expect(err.name).toBe("DbQueryTimeoutError");
  });

  it("stores queryPreview", () => {
    const err = new DbQueryTimeoutError("slow", "SELECT * FROM big_table", 5000);
    expect(err.queryPreview).toBe("SELECT * FROM big_table");
  });

  it("stores timeoutMs", () => {
    const err = new DbQueryTimeoutError("slow", "SELECT 1", 7500);
    expect(err.timeoutMs).toBe(7500);
  });

  it("stores optional cause", () => {
    const cause = new Error("statement_timeout");
    const err = new DbQueryTimeoutError("exceeded", "SELECT 1", 1000, cause);
    expect(err.cause).toBe(cause);
  });
});

// =============================================================================
// ports/db.ts — createTracedDbPort
// =============================================================================

describe("createTracedDbPort", () => {
  it("returns an object with a query method", () => {
    const fakeDb = {
      async query<T extends object>(): Promise<{
        rows: T[];
        rowCount?: number;
      }> {
        return { rows: [], rowCount: 0 };
      },
    };
    const traced = createTracedDbPort(fakeDb);
    expect(typeof traced.query).toBe("function");
  });

  it("delegates to the underlying implementation", async () => {
    const mockResult = { rows: [{ id: 1 }], rowCount: 1 };
    const fakeDb = {
      async query<T extends object>(): Promise<{
        rows: T[];
        rowCount?: number;
      }> {
        return mockResult as unknown as { rows: T[]; rowCount?: number };
      },
    };
    const traced = createTracedDbPort(fakeDb);
    const result = await traced.query("SELECT 1");
    expect(result).toEqual(mockResult);
  });

  it("re-throws errors from underlying implementation", async () => {
    const fakeDb = {
      async query<T extends object>(): Promise<{ rows: T[] }> {
        throw new DbConnectionLostError("pool exhausted");
      },
    };
    const traced = createTracedDbPort(fakeDb);
    await expect(traced.query("SELECT 1")).rejects.toBeInstanceOf(DbConnectionLostError);
  });
});

// =============================================================================
// verify/formal/solver.ts — checkSmt with non-existent binary
// =============================================================================

describe("checkSmt — missing z3 binary", () => {
  afterEach(() => {
    __resetZ3AvailabilityCache();
  });

  it("returns sat: null when z3 binary is not found", async () => {
    const result = await checkSmt("(check-sat)", {
      z3_path: "/nonexistent/z3",
    });
    expect(result.sat).toBeNull();
  });

  it("returns a reason string when binary missing", async () => {
    const result = await checkSmt("(check-sat)", {
      z3_path: "/nonexistent/z3",
    });
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  it("returns a numeric time_ms", async () => {
    const result = await checkSmt("(check-sat)", {
      z3_path: "/nonexistent/z3",
    });
    expect(typeof result.time_ms).toBe("number");
    expect(result.time_ms).toBeGreaterThanOrEqual(0);
  });

  it("never throws — always resolves", async () => {
    await expect(checkSmt("(check-sat)", { z3_path: "/nonexistent/z3" })).resolves.toBeDefined();
  });
});

// =============================================================================
// verify/formal/solver.ts — isZ3Available
// =============================================================================

describe("isZ3Available", () => {
  afterEach(() => {
    __resetZ3AvailabilityCache();
  });

  it("returns false for a nonexistent binary path", async () => {
    const available = await isZ3Available("/nonexistent/z3_binary");
    expect(available).toBe(false);
  });

  it("returns a boolean", async () => {
    __resetZ3AvailabilityCache();
    const available = await isZ3Available("/nonexistent/z3_binary");
    expect(typeof available).toBe("boolean");
  });

  it("__resetZ3AvailabilityCache allows re-probe", async () => {
    // first probe
    await isZ3Available("/nonexistent/z3_binary");
    // reset
    __resetZ3AvailabilityCache();
    // second probe — should work without throwing
    const available2 = await isZ3Available("/nonexistent/z3_binary");
    expect(typeof available2).toBe("boolean");
  });
});

// =============================================================================
// registry/agent-capability.ts — AGENT_KINDS
// =============================================================================

describe("AGENT_KINDS", () => {
  it("contains ARCHITECT", () => {
    expect(AGENT_KINDS).toContain("ARCHITECT");
  });

  it("contains BUILDER", () => {
    expect(AGENT_KINDS).toContain("BUILDER");
  });

  it("contains SCRIBE", () => {
    expect(AGENT_KINDS).toContain("SCRIBE");
  });

  it("contains TESTER", () => {
    expect(AGENT_KINDS).toContain("TESTER");
  });

  it("contains SYNERGY", () => {
    expect(AGENT_KINDS).toContain("SYNERGY");
  });

  it("contains OODA", () => {
    expect(AGENT_KINDS).toContain("OODA");
  });

  it("contains LLM_ROUTER", () => {
    expect(AGENT_KINDS).toContain("LLM_ROUTER");
  });

  it("contains PLUGIN", () => {
    expect(AGENT_KINDS).toContain("PLUGIN");
  });

  it("contains MCP", () => {
    expect(AGENT_KINDS).toContain("MCP");
  });

  it("has exactly 9 entries", () => {
    expect(AGENT_KINDS.length).toBe(9);
  });

  it("all entries are non-empty strings", () => {
    for (const kind of AGENT_KINDS) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// registry/agent-capability.ts — AgentCapabilityCard shape
// =============================================================================

describe("AgentCapabilityCard shape", () => {
  it("accepts a minimal valid card", () => {
    const card: AgentCapabilityCard = {
      agentId: "agent-001",
      kind: "BUILDER",
      skills: ["typescript", "cairo"],
      costTier: "low",
      latencyTier: "medium",
      createdAt: Date.now(),
    };
    expect(card.agentId).toBe("agent-001");
    expect(card.kind).toBe("BUILDER");
    expect(card.skills).toHaveLength(2);
    expect(card.costTier).toBe("low");
    expect(card.latencyTier).toBe("medium");
  });

  it("accepts optional embeddingVector", () => {
    const card: AgentCapabilityCard = {
      agentId: "agent-002",
      kind: "ARCHITECT",
      skills: [],
      costTier: "high",
      latencyTier: "high",
      embeddingVector: [0.1, 0.2, 0.3],
      createdAt: Date.now(),
    };
    expect(card.embeddingVector).toHaveLength(3);
  });
});

// =============================================================================
// skill-manifest/anchor.ts — parseTsaToken (mock token)
// =============================================================================

describe("parseTsaToken — mock tokens", () => {
  it("parses a valid mock token (constructed offline ; anchorWithTsa never produces one)", () => {
    const fakeHash = "a".repeat(64);
    const token = buildMockTsaTokenForTest(fakeHash);
    const info = parseTsaToken(token);
    expect(info.isMock).toBe(true);
    expect(info.authority).toBe("mock");
    expect(info.hashAlgorithm).toBe("SHA-256");
    expect(info.timestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(info.timestamp.getTime())).toBe(false);
  });

  it("mock token timestamp round-trips through parseTsaToken", () => {
    const ts = new Date();
    const token = buildMockTsaTokenForTest("b".repeat(64), ts);
    const info = parseTsaToken(token);
    expect(info.timestamp.getTime()).toBe(ts.getTime());
  });

  it("throws on a malformed base64 token that starts with MOCK_TSA but has bad timestamp", () => {
    const bad = Buffer.from("MOCK_TSA:aabbcc:NOT_A_DATE", "utf8").toString("base64");
    expect(() => parseTsaToken(bad)).toThrow();
  });

  it("throws when token cannot be decoded (no GeneralizedTime and not mock)", () => {
    // A token that is not mock and has no GeneralizedTime in DER
    const garbage = Buffer.from("NOT_MOCK_AND_NO_GENERALIZEDTIME", "utf8").toString("base64");
    expect(() => parseTsaToken(garbage)).toThrow();
  });
});

// =============================================================================
// skill-manifest/anchor.ts — verifyTsaAnchor
// =============================================================================

describe("verifyTsaAnchor", () => {
  const makeManifest = (overrides: Partial<SkillManifest>): SkillManifest => ({
    skillId: "vauban.test.skill",
    version: "1.0.0",
    domain: "test",
    trainingReplayRoot: "c".repeat(64),
    poseidonHash: "d".repeat(64),
    grade: "tsa_fallback",
    createdAt: new Date(),
    ...overrides,
  });

  it("returns false when tsaToken is absent", () => {
    const m = makeManifest({ tsaToken: undefined });
    expect(verifyTsaAnchor(m)).toBe(false);
  });

  it("returns true for a valid mock token matching poseidonHash", () => {
    const poseidonHash = "e".repeat(64);
    const token = buildMockTsaTokenForTest(poseidonHash);
    const m = makeManifest({ tsaToken: token, poseidonHash });
    expect(verifyTsaAnchor(m)).toBe(true);
  });

  it("returns false for a mock token with mismatched hash", () => {
    const tokenHash = "f".repeat(64);
    const token = buildMockTsaTokenForTest(tokenHash);
    const m = makeManifest({
      tsaToken: token,
      poseidonHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(verifyTsaAnchor(m)).toBe(false);
  });

  it("returns false for a totally invalid token", () => {
    const m = makeManifest({ tsaToken: "not_valid_base64!!!" });
    // parseTsaToken will throw, verifyTsaAnchor should catch and return false
    expect(verifyTsaAnchor(m)).toBe(false);
  });

  it("accepts 0x-prefixed poseidonHash in mock token verification", () => {
    const rawHash = "a1b2c3d4e5f6".padEnd(64, "0");
    const token = buildMockTsaTokenForTest(rawHash);
    const m = makeManifest({ tsaToken: token, poseidonHash: `0x${rawHash}` });
    expect(verifyTsaAnchor(m)).toBe(true);
  });
});

// =============================================================================
// skill-manifest/anchor.ts — anchorWithTsa (fail-closed)
// =============================================================================

describe("anchorWithTsa — fail-closed on TSA failure", () => {
  it("throws TsaUnavailableError when the TSA endpoint is unreachable", async () => {
    const hash = "1".repeat(64);
    await expect(
      anchorWithTsa(hash, { tsaUrl: "http://localhost:0", timeout_ms: 100 }),
    ).rejects.toBeInstanceOf(TsaUnavailableError);
  });

  it("TsaUnavailableError carries the manifestHash that failed to anchor", async () => {
    const hash = "2".repeat(64);
    try {
      await anchorWithTsa(hash, { tsaUrl: "http://localhost:0", timeout_ms: 100 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TsaUnavailableError);
      expect((err as TsaUnavailableError).manifestHash).toBe(hash);
    }
  });

  it("never returns a fabricated token ; rejects instead of resolving on failure", async () => {
    const hash = "3".repeat(64);
    await expect(
      anchorWithTsa(hash, { tsaUrl: "http://localhost:0", timeout_ms: 100 }),
    ).rejects.toThrow();
  });
});
