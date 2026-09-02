/**
 * canonical — RFC 8785 JSON canonicalization with deterministic pre-processing.
 *
 * Pre-processing contract (applied depth-first before canonicalize):
 *   - Buffer / Uint8Array   → base64 string (RFC 4648 §4, no padding stripping)
 *   - undefined             → key is omitted (JSON.stringify-compatible semantics)
 *   - Date                  → ISO-8601 string via .toISOString()
 *   - BigInt                → { __bigint: string } (decimal representation)
 *   - NaN / Infinity / -0   → throws NonSerializablePayloadError
 *   - Circular references   → throws NonSerializablePayloadError
 *   - Everything else       → left unchanged (strings, booleans, null, plain numbers)
 *
 * Usage:
 *   import { canonicalize, NonSerializablePayloadError } from './canonical.js';
 *   const json = canonicalize({ b: 2, a: 1 }); // '{"a":1,"b":2}'
 *
 * @module trace/canonical
 */

import { canonicalize as _rfcCanonicalize } from "json-canonicalize";

/**
 * Thrown when the value graph contains a non-serializable primitive
 * (NaN, Infinity, -0) or a circular reference.
 * @public
 */
export class NonSerializablePayloadError extends Error {
  constructor(
    reason: string,
    public readonly path: string[],
  ) {
    super(`NonSerializablePayloadError: ${reason} at path /${path.join("/")}`);
    this.name = "NonSerializablePayloadError";
  }
}

/**
 * Convert a Uint8Array (or Node Buffer) to a base64 string.
 * Uses globalThis.btoa when available (browser/edge), falls back to
 * Buffer.from().toString('base64') on Node.js.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return globalThis.btoa(binary);
  }
  // Node.js fallback
  return Buffer.from(bytes).toString("base64");
}

/**
 * Recursively pre-process a value so that it is safe to pass to the
 * RFC 8785 canonicalizer.  Returns a new value — never mutates input.
 *
 * @param value  Input to preprocess.
 * @param path   Breadcrumb path for error messages (internal use).
 * @param seen   Cycle detection set (internal use).
 */
function preprocess(value: unknown, path: string[], seen: Set<object>): unknown {
  // Null / primitives (boolean, string, number — checked below for special floats)
  if (value === null) return null;
  if (value === undefined) return undefined; // caller omits the key

  // Special float values that cannot be represented in JSON
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new NonSerializablePayloadError("NaN is not serializable", path);
    }
    if (!Number.isFinite(value)) {
      throw new NonSerializablePayloadError(
        `${value > 0 ? "Infinity" : "-Infinity"} is not serializable`,
        path,
      );
    }
    // -0: Object.is(-0, -0) → true but JSON.stringify(-0) === '0'.
    // We normalise -0 → 0 would silently change data.  Throw instead.
    if (Object.is(value, -0)) {
      throw new NonSerializablePayloadError("-0 is not serializable", path);
    }
    return value;
  }

  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;

  // BigInt — JSON-serialisable wrapper
  if (typeof value === "bigint") {
    return { __bigint: value.toString(10) };
  }

  // Date → ISO-8601 string
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Uint8Array / Buffer → base64 string
  if (value instanceof Uint8Array) {
    return uint8ToBase64(value);
  }

  // Objects and Arrays — cycle detection + recursive descent
  if (typeof value === "object") {
    if (seen.has(value as object)) {
      throw new NonSerializablePayloadError("circular reference detected", path);
    }
    seen.add(value as object);

    let result: unknown;
    if (Array.isArray(value)) {
      result = (value as unknown[]).map((item, i) => preprocess(item, [...path, String(i)], seen));
    } else {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const processed = preprocess(v, [...path, k], seen);
        if (processed !== undefined) {
          obj[k] = processed;
        }
        // undefined values → key omitted (consistent with JSON.stringify behaviour)
      }
      result = obj;
    }

    seen.delete(value as object); // allow same object to appear in sibling branches
    return result;
  }

  // Functions, symbols, etc. — omit like JSON.stringify
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  // Unreachable in TypeScript but guards against unknown runtime types
  throw new NonSerializablePayloadError(`unhandled type: ${typeof value}`, path);
}

/**
 * Produce the RFC 8785 canonical JSON string of any value.
 *
 * Pre-processes the value graph (Buffer→base64, Date→ISO-8601,
 * BigInt→{__bigint}, undefined→omit, cycles/NaN/Inf/-0→throw)
 * then applies `json-canonicalize` for deterministic key ordering.
 *
 * @throws {NonSerializablePayloadError} for NaN, Infinity, -0, or cycles.
 * @public
 */
export function canonicalize(value: unknown): string {
  const preprocessed = preprocess(value, [], new Set());
  // json-canonicalize already handles key sorting per RFC 8785.
  // We pass the pre-processed value (all types are now JSON-safe).
  return _rfcCanonicalize(preprocessed);
}
