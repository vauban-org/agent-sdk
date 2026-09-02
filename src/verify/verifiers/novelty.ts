/**
 * verify/verifiers/novelty.ts
 *
 * noveltyLens ; an antifragile refute lens (the diversity gate). It fires when a
 * candidate is a near-duplicate of any item in a reference set (recent accepted
 * outputs, a corpus, a holdout) ; that is, when the candidate lacks novelty. High
 * similarity is a REFUTE signal: the battery inverts it, discounting the stale
 * candidate (soft) or killing it (hard).
 *
 * Similarity is deterministic token-Jaccard over whitespace tokens: no model, no
 * dependency, replay-safe. The engine is "statistical" (a valid deterministic
 * anchor). The cutoff is the battery's voteThreshold rather than a per-lens knob,
 * so the gate's sensitivity stays governed in one place.
 *
 * @module verify/verifiers/novelty
 */

import type { BatteryLens } from "../../compute/battery/types.js";

/**
 * Token-Jaccard similarity in [0,1]: intersection over union of lowercased
 * whitespace tokens. Two empty strings are defined as identical (1); one empty
 * against a non-empty is disjoint (0).
 * @public
 */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Build a diversity (novelty) {@link BatteryLens}. Refute polarity, statistical
 * engine. Scores each candidate by its maximum similarity to the reference set;
 * the battery fires the refuter when that similarity meets the voteThreshold.
 *
 * Defaults to `soft` (a lone soft refuter discounts rather than kills). Pass
 * `criticality: "hard"` for a strict de-duplication gate, or `"advisory"` for a
 * pure novelty signal that never gates.
 * @public
 */
export function noveltyLens<T>(
  reference: readonly T[],
  opts: {
    project?: (c: T) => string;
    criticality?: "hard" | "soft" | "advisory";
    name?: string;
  } = {},
): BatteryLens<T> {
  const project = opts.project ?? ((c: T) => (typeof c === "string" ? c : JSON.stringify(c)));
  const name = opts.name ?? "novelty-gate";
  const criticality = opts.criticality ?? "soft";
  const refStrings = reference.map(project);

  return {
    verifier: {
      name,
      evaluate: (candidate: T) => {
        const s = project(candidate);
        let maxSim = 0;
        let nearest = -1;
        for (let i = 0; i < refStrings.length; i++) {
          const sim = tokenJaccard(s, refStrings[i]);
          if (sim > maxSim) {
            maxSim = sim;
            nearest = i;
          }
        }
        return {
          score: maxSim,
          rationale:
            refStrings.length === 0
              ? "novel: empty reference set (similarity 0)"
              : `max similarity ${maxSim.toFixed(
                  3,
                )} to reference #${nearest} of ${refStrings.length}`,
        };
      },
    },
    polarity: "refute",
    criticality,
    signature: { engine: "statistical" },
  };
}
