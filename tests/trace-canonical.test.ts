/**
 * Tests for trace/canonical.ts — RFC 8785 canonicalization + pre-processing.
 */

import { describe, expect, it } from "vitest";
import { NonSerializablePayloadError, canonicalize } from "../src/trace/canonical.js";

// ─── Key ordering ─────────────────────────────────────────────────────────────

describe("canonicalize — key ordering", () => {
  it("sorts keys lexicographically regardless of insertion order", () => {
    const a = canonicalize({ b: 2, a: 1 });
    const b = canonicalize({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it("produces identical bytes for deeply nested objects with different key orders", () => {
    const x = canonicalize({ z: { y: 1, x: 2 }, a: 3 });
    const y = canonicalize({ a: 3, z: { x: 2, y: 1 } });
    expect(x).toBe(y);
  });
});

// ─── Non-serializable primitives ──────────────────────────────────────────────

describe("canonicalize — non-serializable primitives", () => {
  it("throws NonSerializablePayloadError for NaN", () => {
    expect(() => canonicalize(Number.NaN)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for Infinity", () => {
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for -Infinity", () => {
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for -0", () => {
    expect(() => canonicalize(-0)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for NaN nested in object", () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for circular reference (object)", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalize(obj)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for circular reference (array)", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrowError(NonSerializablePayloadError);
  });

  it("throws NonSerializablePayloadError for deeply nested circular reference", () => {
    const inner: Record<string, unknown> = { value: 42 };
    const outer = { inner, ref: inner };
    // This is NOT a cycle — same reference in sibling branches is OK.
    // Only a true cycle (ancestor in the same path) should throw.
    expect(() => canonicalize(outer)).not.toThrow();

    // Now create a true cycle
    inner.cycleBack = outer;
    expect(() => canonicalize(outer)).toThrowError(NonSerializablePayloadError);
  });
});

// ─── Type transformations ─────────────────────────────────────────────────────

describe("canonicalize — type transformations", () => {
  it("converts Date to ISO-8601 string", () => {
    const d = new Date("2024-01-15T12:00:00.000Z");
    const result = canonicalize(d);
    expect(result).toBe('"2024-01-15T12:00:00.000Z"');
  });

  it("converts Date inside object to ISO-8601", () => {
    const result = JSON.parse(canonicalize({ ts: new Date("2024-01-01T00:00:00.000Z") }));
    expect(result.ts).toBe("2024-01-01T00:00:00.000Z");
  });

  it("converts Uint8Array to base64 string", () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    const result = canonicalize(bytes);
    expect(result).toBe('"aGVsbG8="');
  });

  it("converts Buffer (Node) to base64 string", () => {
    const buf = Buffer.from("hello");
    const result = canonicalize(buf);
    expect(result).toBe('"aGVsbG8="');
  });

  it("converts BigInt to { __bigint: string }", () => {
    const result = JSON.parse(canonicalize(BigInt("123456789012345678901234567890")));
    expect(result).toEqual({ __bigint: "123456789012345678901234567890" });
  });

  it("omits undefined values", () => {
    const result = JSON.parse(canonicalize({ a: 1, b: undefined, c: 3 }));
    expect(result).toEqual({ a: 1, c: 3 });
    expect("b" in result).toBe(false);
  });

  it("handles null correctly", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize({ x: null })).toBe('{"x":null}');
  });

  it("handles booleans correctly", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("handles plain numbers", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(3.14)).toBe("3.14");
    expect(canonicalize(0)).toBe("0");
  });

  it("handles empty object and array", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
  });
});

// ─── Roundtrip property ───────────────────────────────────────────────────────

describe("canonicalize — roundtrip", () => {
  /**
   * Simple objects (string/number/boolean/null/array/nested) must roundtrip:
   * JSON.parse(canonicalize(x)) deep-equals x (for plain-JSON-compatible values).
   */
  const PLAIN_FIXTURES: unknown[] = [
    { a: 1 },
    { b: "hello", a: 42 },
    [1, 2, 3],
    null,
    true,
    false,
    42,
    "hello",
    { nested: { deep: { value: 99 } } },
    { arr: [1, { x: 2 }, "three"] },
  ];

  for (const fixture of PLAIN_FIXTURES) {
    it(`roundtrips ${JSON.stringify(fixture)}`, () => {
      const result = JSON.parse(canonicalize(fixture));
      expect(result).toEqual(fixture);
    });
  }

  it("x1000 roundtrip: random plain-JSON objects deep-equal after parse(canonicalize(x))", () => {
    const SEED_OBJECTS: Array<Record<string, number>> = [];
    for (let i = 0; i < 1000; i++) {
      // Generate a small object with random key order
      const keys = ["z", "a", "m", "b", "x"];
      const obj: Record<string, number> = {};
      // Shuffle keys via sort with random comparator (non-deterministic order)
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      for (const k of shuffled) {
        obj[k] = Math.floor(Math.random() * 1000);
      }
      SEED_OBJECTS.push(obj);
    }

    for (const obj of SEED_OBJECTS) {
      const canonical = canonicalize(obj);
      const parsed = JSON.parse(canonical) as Record<string, number>;
      // Value equivalence
      expect(parsed).toEqual(obj);
      // Key order must be sorted
      const canonicalKeys = Object.keys(parsed);
      const sortedKeys = [...canonicalKeys].sort();
      expect(canonicalKeys).toEqual(sortedKeys);
    }
  });
});

// ─── Same-reference in sibling branches ──────────────────────────────────────

describe("canonicalize — shared (non-cyclic) references", () => {
  it("allows the same object to appear in sibling branches (not a cycle)", () => {
    const shared = { value: 42 };
    const obj = { a: shared, b: shared };
    // Should NOT throw — sibling references are not cycles
    const result = JSON.parse(canonicalize(obj));
    expect(result).toEqual({ a: { value: 42 }, b: { value: 42 } });
  });
});

// ─── Error properties ─────────────────────────────────────────────────────────

describe("NonSerializablePayloadError", () => {
  it("has name NonSerializablePayloadError", () => {
    let caught: unknown;
    try {
      canonicalize(Number.NaN);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonSerializablePayloadError);
    expect((caught as NonSerializablePayloadError).name).toBe("NonSerializablePayloadError");
  });

  it("exposes path array", () => {
    let caught: unknown;
    try {
      canonicalize({ outer: { inner: Number.NaN } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonSerializablePayloadError);
    expect((caught as NonSerializablePayloadError).path).toEqual(["outer", "inner"]);
  });
});
