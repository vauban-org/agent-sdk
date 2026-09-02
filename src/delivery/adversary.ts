/**
 * delivery/adversary.ts
 *
 * Builds perspective-diverse adversarial-twin lenses for the stage gate.
 *
 * The battery resolves every `lens.verifier.evaluate` call via
 * `await Promise.resolve(...)`, so both sync and async evaluate functions work.
 * Here we choose ASYNC evaluate: the refuter is an async I/O operation (an LLM
 * call injected by the driver), so the lens exposes a Promise directly rather
 * than resolving through an awkward sync wrapper. The battery handles it
 * transparently.
 *
 * Design: each lens wraps a distinct adversarial angle from ADVERSARY_ANGLES.
 * Perspective diversity is the key property (arXiv:2502.20379 BoN-MAV): N lenses
 * asking the same question provide zero extra signal; N lenses each attacking a
 * different facet of the artifact maximise coverage.
 *
 * The refuter is injected (not imported) to keep this module pure and testable
 * without a live LLM.
 *
 * @module delivery/adversary
 */

import type { BatteryLens } from "../compute/battery/types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Injected LLM refuter. The driver (CLI/Vera) supplies the real model call;
 * tests supply a mock. Returns `refuted:true` when the specified angle of
 * attack reveals a problem in the artifact.
 */
export type RefuteFn = (input: {
  stageId: string;
  artifact: string;
  angle: string;
}) => Promise<{ refuted: boolean; rationale: string }>;

/** Adversary intensity for a given stage gate. */
export type AdversaryIntensity = "none" | "judge" | "refute-quorum";

export interface AdversaryConfigInput {
  /**
   * "none"            ; no adversarial lenses (pass-through).
   * "judge"           ; 1 soft refute lens (discounts composite, never kills alone).
   * "refute-quorum"   ; >=2 soft refute lenses (strict majority can kill).
   */
  readonly intensity: AdversaryIntensity;
  /**
   * Number of lenses for "refute-quorum". Defaults to 2. Clamped UP to >=2
   * (a quorum of 1 is semantically identical to "judge"). The requested count
   * is honored exactly: the first N angles come from ADVERSARY_ANGLES, and any
   * count beyond the fixed list is filled with distinct generated labels
   * (`aspect-<i>`) so exactly `lenses` distinct lenses are always built; no
   * silent truncation that would shift the quorum threshold. Ignored for
   * "judge" (always 1) and "none" (always 0).
   */
  readonly lenses?: number;
}

// ─── Adversarial angles (perspective-diverse) ────────────────────────────────

/**
 * Fixed catalog of adversarial attack angles. The first N angles seed the lens
 * set so each lens attacks a distinct facet; redundant lenses provide zero extra
 * signal. When more lenses than angles are requested, distinct generated labels
 * extend the list (see `distinctAngles` below ; module-private, so no @link).
 */
export const ADVERSARY_ANGLES: readonly string[] = [
  "completeness",
  "correctness",
  "security",
  "ambiguity",
  "testability",
  "assumptions",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function clampLensCount(count: number): number {
  return count < 2 ? 2 : count;
}

/**
 * Return exactly `count` distinct angle labels: the fixed catalog first, then
 * generated `aspect-<i>` labels to honor the requested count without truncation.
 */
function distinctAngles(count: number): string[] {
  const out = ADVERSARY_ANGLES.slice(0, count);
  for (let i = out.length; i < count; i++) {
    out.push(`aspect-${i}`);
  }
  return out;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Build adversarial-twin lenses for the battery.
 *
 * "none"           ; returns [].
 * "judge"          ; returns 1 soft refute lens (angle: "completeness").
 * "refute-quorum"  ; returns exactly `config.lenses ?? 2` soft refute lenses
 *                    (clamped up to >=2), each attacking a distinct angle. The
 *                    requested count is always honored; counts beyond the fixed
 *                    catalog are filled with generated labels (no truncation).
 *
 * Each lens has:
 *   - polarity: "refute"
 *   - criticality: "soft"  (a quorum kills; a lone lens only discounts)
 *   - signature.engine: "llm-judge"
 *   - verifier.name: `adversary:<stageId>:<angleSlug>` (unique per lens)
 *   - verifier.evaluate: async; refutes the RECEIVED candidate (not a captured
 *     copy), returns score 1 when refuted, 0 otherwise. On refuter error it
 *     FAILS CLOSED (score 1, treated as a violation) so an infra failure cannot
 *     silently turn the adversary into a no-op.
 *
 * The returned lenses are NOT the deterministic anchor floor; that floor
 * (hard affirm lenses built from AnchorSpec) must still be present in the
 * battery call to satisfy the non-llm-judge governance invariant.
 */
export function buildAdversaryLenses(opts: {
  readonly stageId: string;
  readonly artifact: string;
  readonly config: AdversaryConfigInput;
  readonly refute: RefuteFn;
}): BatteryLens<string>[] {
  const { stageId, config, refute } = opts;

  if (config.intensity === "none") return [];

  const lensCount = config.intensity === "judge" ? 1 : clampLensCount(config.lenses ?? 2);

  const angles = distinctAngles(lensCount);

  return angles.map(
    (angle): BatteryLens<string> => ({
      verifier: {
        name: `adversary:${slugify(stageId)}:${angle}`,
        evaluate: async (candidate: string) => {
          try {
            const result = await refute({
              stageId,
              artifact: candidate,
              angle,
            });
            return {
              score: result.refuted ? 1 : 0,
              rationale: result.rationale,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Fail closed: a refuter that errors is treated as a violation so a
            // refute-quorum still counts it as fired (no silent no-op on infra
            // failure).
            return {
              score: 1,
              rationale: `refuter error (fail-closed): ${message}`,
            };
          }
        },
      },
      polarity: "refute",
      criticality: "soft",
      signature: { engine: "llm-judge" },
    }),
  );
}
