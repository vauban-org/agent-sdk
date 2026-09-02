/**
 * recall/schema — contract types + schema validation tests.
 *
 * Promoted from apps/agents/forecaster/tests/recall/schema.test.ts
 * per ADR-ECO-065 (sprint-805 Stage 2). Import paths updated; BrainChunk
 * renamed to RecallChunk throughout.
 *
 * Verifies .strict() equivalence: unknown keys are rejected, valid shapes pass.
 */

import { describe, expect, it } from "vitest";
import {
  parseBrainChunk,
  parseFreshnessMarker,
  parseRecallChunk,
  parseRecallOptions,
  parseRecallResult,
} from "../src/recall/schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const validChunk = {
  id: "abc-123",
  content: "Paris is the capital of France.",
  hybrid_score: 0.82,
  cross_encoder_score: 0.91,
  similarity: 0.77,
  category: "fact",
  tags: ["geography"],
  created_at: "2026-01-01T00:00:00Z",
  brain_id: null,
  brain_slug: null,
};

const validOptions = {
  mode: "chunks" as const,
  tier: "agentic" as const,
  topK: 5,
  brainIds: ["uuid-1"],
  tags: ["geography"],
};

const validResult = {
  chunks: [validChunk],
  answer: "Paris",
  strategy_used: "direct",
  hops_used: 1,
  refs: ["abc-123"],
  freshness: [],
};

const validFreshness = {
  entryId: "abc-123",
  validFrom: "2026-01-01T00:00:00Z",
  stale: false,
};

// ─── RecallOptions ────────────────────────────────────────────────────────────

describe("parseRecallOptions", () => {
  it("accepts a minimal valid shape (mode only)", () => {
    const result = parseRecallOptions({ mode: "answer" });
    expect(result.mode).toBe("answer");
  });

  it("accepts a full valid shape", () => {
    const result = parseRecallOptions(validOptions);
    expect(result.tier).toBe("agentic");
    expect(result.topK).toBe(5);
  });

  it("rejects unknown keys (.strict() equivalent)", () => {
    expect(() => parseRecallOptions({ mode: "chunks", unknown_field: true })).toThrow(
      "unknown keys",
    );
  });

  it("rejects invalid mode", () => {
    expect(() => parseRecallOptions({ mode: "wrong" })).toThrow("mode");
  });

  it("rejects invalid tier", () => {
    expect(() => parseRecallOptions({ mode: "chunks", tier: "ultra" })).toThrow("tier");
  });

  it("rejects topK out of range", () => {
    expect(() => parseRecallOptions({ mode: "chunks", topK: 0 })).toThrow("topK");
    expect(() => parseRecallOptions({ mode: "chunks", topK: 21 })).toThrow("topK");
  });

  it("rejects minSimilarity out of range", () => {
    expect(() => parseRecallOptions({ mode: "chunks", minSimilarity: 1.5 })).toThrow(
      "minSimilarity",
    );
  });

  it("rejects non-string array in brainIds", () => {
    expect(() => parseRecallOptions({ mode: "chunks", brainIds: [123] })).toThrow("brainIds");
  });

  it("rejects non-object input", () => {
    expect(() => parseRecallOptions(null)).toThrow();
    expect(() => parseRecallOptions("string")).toThrow();
  });
});

// ─── RecallChunk (parseRecallChunk — canonical SDK name) ─────────────────────

describe("parseRecallChunk", () => {
  it("accepts a valid chunk", () => {
    const result = parseRecallChunk(validChunk);
    expect(result.id).toBe("abc-123");
    expect(result.brain_id).toBeNull();
  });

  it("accepts null scores", () => {
    const chunk = {
      ...validChunk,
      hybrid_score: null,
      cross_encoder_score: null,
      similarity: null,
    };
    expect(() => parseRecallChunk(chunk)).not.toThrow();
  });

  it("rejects unknown keys (.strict() equivalent)", () => {
    expect(() => parseRecallChunk({ ...validChunk, extra_field: "surprise" })).toThrow(
      "unknown keys",
    );
  });

  it("rejects missing id", () => {
    const { id: _id, ...rest } = validChunk;
    expect(() => parseRecallChunk(rest)).toThrow("id");
  });

  it("rejects missing content", () => {
    const { content: _c, ...rest } = validChunk;
    expect(() => parseRecallChunk(rest)).toThrow("content");
  });

  it("rejects non-array tags", () => {
    expect(() => parseRecallChunk({ ...validChunk, tags: "tag1" })).toThrow("tags");
  });
});

// ─── parseBrainChunk — backward-compat alias ──────────────────────────────────

describe("parseBrainChunk (alias for parseRecallChunk)", () => {
  it("is identical to parseRecallChunk", () => {
    const r1 = parseRecallChunk(validChunk);
    const r2 = parseBrainChunk(validChunk);
    expect(r1).toEqual(r2);
  });

  it("accepts a valid chunk via alias", () => {
    const result = parseBrainChunk(validChunk);
    expect(result.id).toBe("abc-123");
    expect(result.brain_id).toBeNull();
  });
});

// ─── FreshnessMarker ─────────────────────────────────────────────────────────

describe("parseFreshnessMarker", () => {
  it("accepts a valid marker without optional fields", () => {
    const result = parseFreshnessMarker({ entryId: "abc", stale: false });
    expect(result.stale).toBe(false);
  });

  it("accepts a full valid marker", () => {
    const result = parseFreshnessMarker(validFreshness);
    expect(result.entryId).toBe("abc-123");
    expect(result.validFrom).toBe("2026-01-01T00:00:00Z");
  });

  it("rejects unknown keys (.strict() equivalent)", () => {
    expect(() => parseFreshnessMarker({ entryId: "abc", stale: false, extra: 1 })).toThrow(
      "unknown keys",
    );
  });

  it("rejects non-boolean stale", () => {
    expect(() => parseFreshnessMarker({ entryId: "abc", stale: "yes" })).toThrow("stale");
  });
});

// ─── RecallResult ─────────────────────────────────────────────────────────────

describe("parseRecallResult", () => {
  it("accepts a valid result", () => {
    const result = parseRecallResult(validResult);
    expect(result.strategy_used).toBe("direct");
    expect(result.chunks).toHaveLength(1);
  });

  it("accepts empty chunks + null answer (degraded path)", () => {
    const degraded = {
      chunks: [],
      answer: null,
      strategy_used: "degraded",
      hops_used: 0,
      refs: [],
      freshness: [],
    };
    expect(() => parseRecallResult(degraded)).not.toThrow();
  });

  it("rejects unknown keys (.strict() equivalent)", () => {
    expect(() => parseRecallResult({ ...validResult, extra_key: true })).toThrow("unknown keys");
  });

  it("rejects non-number hops_used", () => {
    expect(() => parseRecallResult({ ...validResult, hops_used: "3" })).toThrow("hops_used");
  });

  it("rejects invalid nested chunk", () => {
    expect(() => parseRecallResult({ ...validResult, chunks: [{ bad: true }] })).toThrow();
  });
});
