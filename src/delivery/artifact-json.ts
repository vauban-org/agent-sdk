/**
 * delivery/artifact-json.ts
 *
 * Shape predicates over a stage artifact's parsed JSON. This is the leaf of the
 * delivery gate module: pure, dependency-free, shared by the anchor registry,
 * the grounded test runner, and the config validator.
 *
 * The strictness distinctions here are load-bearing, not cosmetic: a B2-hardened
 * anchor must reject `false`, `0`, `null`, `[]`, `{}` and `[null]` where a plain
 * truthiness test would let a producer seal a stage on an empty field.
 *
 * @module delivery/artifact-json
 */

/** Parse an artifact as a JSON OBJECT. Arrays, scalars, and parse errors yield null. */
export function parseJson(artifact: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(artifact);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Loose non-emptiness: used by the anchors that only need "the field carries something". */
export function nonEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  // A plain object must have at least one key; {} is empty (an empty scope
  // must not clear the nonempty-fields anchor).
  if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
  return v !== null && v !== undefined;
}

/**
 * A real reference: a non-empty string. Used by the type-strict ref anchors so
 * that `false`, `0`, `null`, `[]`, `{}` are all rejected (they are NOT a ref).
 * Deliberately stricter than `nonEmpty` (which other callers rely on).
 */
export function isRealRef(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * A non-null object with at least one own key.
 */
export function isNonEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
}

/**
 * True when `v` is an array carrying at least one REAL element: a non-empty
 * string or a non-empty object. Rejects `[]`, `[null]`, `[false]`, `[0]`,
 * `[""]`, `[[]]` (the type-strict bar for the ref anchors).
 */
export function hasRealElement(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.some((e) => isRealRef(e) || isNonEmptyObject(e));
}
