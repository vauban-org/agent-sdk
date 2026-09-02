/**
 * recall/cache-safety — cache-safety invariant tests.
 *
 * Promoted from apps/agents/forecaster/tests/recall/cache-safety.test.ts
 * per ADR-ECO-065 (sprint-805 Stage 2). Import paths updated; BrainChunk
 * renamed to RecallChunk throughout.
 *
 *  - renderMemoryContext: deterministic output (stable order, CDATA escaping,
 *    null-score handling, empty input).
 *  - assertCacheSafe: throws on differing prefixes, passes on identical.
 */

import { describe, expect, it } from "vitest";
import { CacheSafetyViolationError, assertCacheSafe } from "../src/recall/cache-safety.js";
import { renderMemoryContext } from "../src/recall/memory-context.js";
import type { RecallChunk } from "../src/recall/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function chunk(over: Partial<RecallChunk> & Pick<RecallChunk, "id">): RecallChunk {
  return {
    id: over.id,
    content: over.content ?? `content-${over.id}`,
    hybrid_score: over.hybrid_score ?? null,
    cross_encoder_score: over.cross_encoder_score ?? null,
    similarity: over.similarity ?? null,
    category: over.category ?? "fact",
    tags: over.tags ?? [],
    created_at: over.created_at ?? "2026-01-01T00:00:00Z",
    brain_id: over.brain_id ?? null,
    brain_slug: over.brain_slug ?? null,
  };
}

// ─── renderMemoryContext ───────────────────────────────────────────────────────

describe("renderMemoryContext", () => {
  it("returns empty block for empty input", () => {
    expect(renderMemoryContext([])).toBe("<memory_context></memory_context>");
  });

  it("renders a single chunk with id, score, CDATA content", () => {
    const out = renderMemoryContext([chunk({ id: "a1", content: "hello", hybrid_score: 0.5 })]);
    expect(out).toContain("<memory_context>");
    expect(out).toContain('<chunk id="a1" score="0.5000">');
    expect(out).toContain("<content><![CDATA[hello]]></content>");
    expect(out).toContain("</memory_context>");
  });

  it("sorts by hybrid_score desc", () => {
    const out = renderMemoryContext([
      chunk({ id: "low", hybrid_score: 0.1 }),
      chunk({ id: "high", hybrid_score: 0.9 }),
      chunk({ id: "mid", hybrid_score: 0.5 }),
    ]);
    const idxHigh = out.indexOf('id="high"');
    const idxMid = out.indexOf('id="mid"');
    const idxLow = out.indexOf('id="low"');
    expect(idxHigh).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxLow);
  });

  it("breaks ties by id ascending", () => {
    const out = renderMemoryContext([
      chunk({ id: "zzz", hybrid_score: 0.5 }),
      chunk({ id: "aaa", hybrid_score: 0.5 }),
      chunk({ id: "mmm", hybrid_score: 0.5 }),
    ]);
    const idxA = out.indexOf('id="aaa"');
    const idxM = out.indexOf('id="mmm"');
    const idxZ = out.indexOf('id="zzz"');
    expect(idxA).toBeLessThan(idxM);
    expect(idxM).toBeLessThan(idxZ);
  });

  it("sorts null-score chunks last, ordered by id", () => {
    const out = renderMemoryContext([
      chunk({ id: "n2", hybrid_score: null }),
      chunk({ id: "scored", hybrid_score: 0.3 }),
      chunk({ id: "n1", hybrid_score: null }),
    ]);
    const idxScored = out.indexOf('id="scored"');
    const idxN1 = out.indexOf('id="n1"');
    const idxN2 = out.indexOf('id="n2"');
    expect(idxScored).toBeLessThan(idxN1);
    expect(idxN1).toBeLessThan(idxN2);
  });

  it("renders score=null literal for null hybrid_score", () => {
    const out = renderMemoryContext([chunk({ id: "x", hybrid_score: null })]);
    expect(out).toContain('<chunk id="x" score="null">');
  });

  it("is deterministic: identical output across calls regardless of input order", () => {
    const a = [
      chunk({ id: "c", hybrid_score: 0.2, content: "gamma" }),
      chunk({ id: "a", hybrid_score: 0.8, content: "alpha" }),
      chunk({ id: "b", hybrid_score: 0.5, content: "beta" }),
    ];
    const b = [
      chunk({ id: "b", hybrid_score: 0.5, content: "beta" }),
      chunk({ id: "c", hybrid_score: 0.2, content: "gamma" }),
      chunk({ id: "a", hybrid_score: 0.8, content: "alpha" }),
    ];
    expect(renderMemoryContext(a)).toBe(renderMemoryContext(b));
  });

  it("escapes the CDATA terminator ]]> in content", () => {
    const out = renderMemoryContext([
      chunk({ id: "evil", hybrid_score: 0.5, content: "before]]>after" }),
    ]);
    // The raw "]]>" must not appear except as the closing delimiter of the
    // content element; the injected one is split.
    expect(out).toContain("before]]]]><![CDATA[>after");
  });

  it("does not mutate the input array", () => {
    const input = [chunk({ id: "x", hybrid_score: 0.1 }), chunk({ id: "y", hybrid_score: 0.9 })];
    const snapshot = input.map((c) => c.id);
    renderMemoryContext(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });
});

// ─── assertCacheSafe ──────────────────────────────────────────────────────────

describe("assertCacheSafe", () => {
  it("passes (no throw) on byte-identical prefixes", () => {
    const prefix = "SYSTEM\nstable T0 block\n";
    expect(() => assertCacheSafe(prefix, prefix)).not.toThrow();
  });

  it("passes on identical empty strings", () => {
    expect(() => assertCacheSafe("", "")).not.toThrow();
  });

  it("throws CacheSafetyViolationError when prefixes differ", () => {
    expect(() => assertCacheSafe("SYSTEM stable", "SYSTEM stable + leaked memory")).toThrow(
      CacheSafetyViolationError,
    );
  });

  it("throws when a per-turn value leaked into the prefix", () => {
    const before = "SYSTEM\nrole: forecaster\n";
    const after = "SYSTEM\nrole: forecaster\nsessionId: abc-123\n";
    expect(() => assertCacheSafe(before, after)).toThrow(/Cacheable prefix changed/);
  });

  it("reports the divergence index on the error", () => {
    try {
      assertCacheSafe("abcdef", "abcXef");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CacheSafetyViolationError);
      expect((err as CacheSafetyViolationError).divergenceIndex).toBe(3);
    }
  });

  it("detects a pure-length difference (suffix appended)", () => {
    try {
      assertCacheSafe("abc", "abcd");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as CacheSafetyViolationError).divergenceIndex).toBe(3);
    }
  });
});
