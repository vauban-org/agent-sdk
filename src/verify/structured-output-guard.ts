/**
 * verify/structured-output-guard.ts
 *
 * StructuredOutputGuard ; the first mandatory lens for any battery that gates an
 * LLM's structured output. It wraps `parseStructuredOutput` (markdown-fence strip
 * plus JSON.parse plus optional Zod validation) and scores the result on a
 * three-level scale:
 *
 *   1.0  pristine  ; the raw string parsed and schema-validated with no repair.
 *   0.5  repaired  ; a valid value was recovered only after fence-stripping/trim.
 *   0.0  rejected  ; unparseable, or parsed but schema-invalid.
 *
 * The engine is "rule": a pure, deterministic parse with no model in the loop, so
 * a battery that includes this guard automatically satisfies the deterministic
 * anchor invariant (a learned judge can be fooled; a JSON+schema check cannot,
 * arXiv:2603.06621). As a hard affirm lens at the default 0.5 threshold it kills
 * only the rejected (0.0) candidates; repaired (0.5) and pristine (1.0) survive,
 * and the battery composite ranks pristine above repaired.
 *
 * @module verify/structured-output-guard
 */

import type { ZodSchema } from "zod";
import type { BatteryLens } from "../compute/battery/types.js";
import { parseStructuredOutput } from "../llm/parse-structured-output.js";

/**
 * Outcome of guarding one raw string against a schema.
 * @public
 */
export interface StructuredOutputVerdict<T> {
  /** 1 = pristine, 0.5 = repaired, 0 = rejected. */
  readonly score: 1 | 0.5 | 0;
  readonly rationale: string;
  /** Parsed value when score > 0; null when rejected. */
  readonly value: T | null;
  /** True when the value was recovered only after repair (score 0.5). */
  readonly repaired: boolean;
}

/**
 * Guard a single raw LLM string against a Zod schema.
 *
 * Deterministic and synchronous: tries a pristine parse first (JSON.parse on the
 * raw string), then a repaired parse (fence-strip via `parseStructuredOutput`),
 * then reports rejection. Never throws ; failure is encoded as score 0.
 * @public
 */
export function guardStructuredOutput<T>(
  schema: ZodSchema<T>,
  raw: string,
): StructuredOutputVerdict<T> {
  // Pristine: the raw string is already clean JSON that satisfies the schema.
  try {
    const direct: unknown = JSON.parse(raw);
    const v = schema.safeParse(direct);
    if (v.success) {
      return {
        score: 1,
        rationale: "valid: parsed and schema-validated with no repair",
        value: v.data,
        repaired: false,
      };
    }
  } catch {
    // not pristine JSON; fall through to the repair attempt
  }

  // Repaired: recoverable only after markdown-fence stripping / trimming.
  try {
    const repaired = parseStructuredOutput<T>(raw, { schema });
    return {
      score: 0.5,
      rationale: "repaired: markdown-fence stripping or trimming was required before a valid parse",
      value: repaired,
      repaired: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      score: 0,
      rationale: `rejected: ${msg}`,
      value: null,
      repaired: false,
    };
  }
}

/**
 * Build a {@link BatteryLens} that guards a raw LLM string against a Zod schema.
 *
 * Defaults to a hard affirm lens (engine "rule"): an unparseable candidate scores
 * 0 and is killed by the battery; a repaired or pristine candidate survives.
 * @public
 */
export function structuredOutputGuard<T>(
  schema: ZodSchema<T>,
  opts: { name?: string; criticality?: "hard" | "soft" } = {},
): BatteryLens<string> {
  const name = opts.name ?? "structured-output-guard";
  const criticality = opts.criticality ?? "hard";
  return {
    verifier: {
      name,
      evaluate: (raw: string) => {
        const v = guardStructuredOutput(schema, raw);
        return { score: v.score, rationale: v.rationale };
      },
    },
    polarity: "affirm",
    criticality,
    signature: { engine: "rule" },
  };
}
