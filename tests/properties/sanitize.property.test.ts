/**
 * Property-based tests — sanitizeExternalInput idempotence (Sprint-470).
 *
 * Property: sanitize(sanitize(x)) === sanitize(x)
 * More precisely: for any array of items with string content,
 * applying sanitizeExternalInput twice produces the same kept/discarded
 * classification and identical content as a single pass.
 *
 * Verified across:
 *   - fc.string()                   — ASCII strings (fast-check v4 default)
 *   - fc.string({ unit: "grapheme-composite" }) — Unicode BMP graphemes
 *   - fc.string({ unit: "binary" })  — full Unicode including supplementary planes
 *
 * 1000 runs via fc.assert per property.
 *
 * Note: fc.unicodeString / fc.fullUnicodeString were removed in fast-check v4.
 * The replacement is fc.string({ unit }) — see fast-check v4 migration guide.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sanitizeExternalInput } from "../../src/safety/sanitize.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Item = { content: string };

/**
 * Apply sanitizeExternalInput once and return observable output per item.
 */
function sanitizeOnce(items: Item[]) {
  return sanitizeExternalInput(items).map((r) => ({
    kept: r.kept,
    content: r.item.content,
  }));
}

/**
 * Core idempotence check: items that survive the first pass must also survive
 * the second pass unchanged (no further truncation, no new discards).
 */
function assertIdempotent(items: Item[]): void {
  const once = sanitizeOnce(items);

  // Build the second-pass input: only items that were kept, with (possibly
  // truncated) content from the first pass.
  const keptAfterFirst = items
    .map((item, idx) => ({ item, result: once[idx]! }))
    .filter(({ result }) => result.kept)
    .map(({ result }) => ({ content: result.content }));

  const second = sanitizeExternalInput(keptAfterFirst).map((r) => ({
    kept: r.kept,
    content: r.item.content,
  }));

  // Every item that survived the first pass must also survive the second.
  for (const r of second) {
    expect(r.kept).toBe(true);
  }
  // Content must be stable (no further truncation after first pass).
  for (let i = 0; i < second.length; i++) {
    expect(second[i]!.content).toBe(keptAfterFirst[i]!.content);
  }
}

// ─── Idempotence properties ───────────────────────────────────────────────────

describe("property — sanitizeExternalInput idempotence", () => {
  it("sanitize(sanitize(x)) === sanitize(x) for ASCII strings", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ maxLength: 600 }).map((content) => ({ content })),
          { minLength: 0, maxLength: 20 },
        ),
        (items) => {
          assertIdempotent(items);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("sanitize(sanitize(x)) === sanitize(x) for Unicode grapheme strings", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: "grapheme-composite", maxLength: 600 }).map((content) => ({ content })),
          { minLength: 0, maxLength: 20 },
        ),
        (items) => {
          assertIdempotent(items);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("sanitize(sanitize(x)) === sanitize(x) for full Unicode binary strings", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ unit: "binary", maxLength: 600 }).map((content) => ({ content })),
          { minLength: 0, maxLength: 20 },
        ),
        (items) => {
          assertIdempotent(items);
        },
      ),
      // 500 runs: binary string generation with maxLength 600 is slower per run.
      { numRuns: 500 },
    );
  });
});
