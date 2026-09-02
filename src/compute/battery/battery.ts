/**
 * compute/battery/battery.ts
 *
 * runVerifierBattery ; the governed rejection-sampling engine.
 *
 * Shape stolen from bon-mav (compute/strategies/bon-mav.ts): build an N x M score
 * matrix over N candidates and M verifiers, then choose. We deliberately do NOT
 * wrap `bonMavStrategy` itself: its `mavMatrix` is score-only and discards each
 * verifier's rationale, which the governance layer needs for the Art. 14
 * "why-rejected" reason on every kept reject. Evaluating the lenses once here
 * captures `{score, rationale}` in a single pass (no double calls, determinism
 * preserved) and `assertVerifierResult` guards untrusted verifier output exactly
 * as bon-mav does.
 *
 * What the battery adds on top of the raw matrix (the moat):
 *   - polarity: refuters invert (a high refuter score counts toward a KILL).
 *   - criticality: hard lenses can single-handedly kill; soft lenses only score;
 *     advisory lenses are logged and never gate.
 *   - refute-kill quorum: a strict majority of gating refute lenses ⇒ fail-closed.
 *   - Completeness: every non-accepted candidate is retained in `rejected` with a
 *     reason (Atropos discards the reject-set; we keep it as proof).
 *   - ONE audit step (phase "guard", type "guard_check") whose outputHash =
 *     sha256(canonical(decision core)); the host trace chain folds it into rootHash.
 *
 * @module compute/battery/battery
 */

import { sha256 } from "../../proof/sha256.js";
import { canonicalize } from "../../trace/canonical.js";
import { assertVerifierResult } from "../verifier.js";
import type {
  BatteryDecision,
  BatteryLens,
  BatteryTraceStep,
  CandidateVerdict,
  LensVerdict,
  RejectedCandidate,
  RunVerifierBatteryOptions,
} from "./types.js";

/**
 * Guard name stamped on the emitted audit step.
 * @public
 */
export const VERIFIER_BATTERY_GUARD = "verifier-battery";

/**
 * Thrown when a battery is invoked without its governance invariants:
 * a governing ADR-ECO, a run id, at least one candidate, at least one gating
 * lens, and at least one deterministic (non-llm-judge) anchor lens.
 * @public
 */
export class BatteryGovernanceError extends Error {
  constructor(reason: string) {
    super(`BatteryGovernanceError: ${reason}`);
    this.name = "BatteryGovernanceError";
  }
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Run the verifier battery over a set of pre-generated candidates.
 *
 * Pure and deterministic given (input, candidates, lenses, clock sequence): the
 * only environmental reads are `clock.now()` (called exactly twice), so a
 * RecordedClock reproduces a byte-identical audit step on replay. No randomness
 * is used; rejection sampling here ranks PROVIDED candidates rather than drawing
 * new ones.
 *
 * @throws {BatteryGovernanceError} when a governance invariant is violated.
 * @public
 */
export async function runVerifierBattery<TOutput>(
  input: unknown,
  candidates: readonly TOutput[],
  lenses: readonly BatteryLens<TOutput>[],
  opts: RunVerifierBatteryOptions,
): Promise<BatteryDecision<TOutput>> {
  const { clock, runId, adrEco, voteThreshold = 0.5, signal } = opts;

  // ── Governance guards: reject cargo-cult gates before any work is done ──
  if (typeof adrEco !== "string" || adrEco.trim().length === 0) {
    throw new BatteryGovernanceError(
      "adrEco is mandatory: a battery with no governing decision record is not auditable",
    );
  }
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new BatteryGovernanceError("runId is mandatory (anti-splice AR6)");
  }
  if (candidates.length < 1) {
    throw new BatteryGovernanceError("at least 1 candidate is required");
  }
  if (lenses.length < 1) {
    throw new BatteryGovernanceError("at least 1 lens is required");
  }
  if (!lenses.some((l) => l.criticality !== "advisory")) {
    throw new BatteryGovernanceError(
      "at least one non-advisory (hard|soft) lens is required: an advisory-only battery gates nothing",
    );
  }
  if (!lenses.some((l) => l.signature.engine !== "llm-judge")) {
    throw new BatteryGovernanceError(
      "at least one non-llm-judge lens is required (deterministic anchor; arXiv:2603.06621)",
    );
  }
  if (!Number.isFinite(voteThreshold) || voteThreshold < 0 || voteThreshold > 1) {
    throw new BatteryGovernanceError(`voteThreshold must be in [0,1], got ${voteThreshold}`);
  }

  const start = clock.now();

  // ── N x M score+rationale matrix (bon-mav shape; rationale-preserving) ──
  const m = lenses.length;
  const flat = await Promise.all(
    candidates.flatMap((cand) =>
      lenses.map(async (lens) => {
        if (signal?.aborted) throw new Error("aborted");
        const r = await Promise.resolve(lens.verifier.evaluate(cand));
        assertVerifierResult(r);
        return { score: r.score, rationale: r.rationale };
      }),
    ),
  );
  const rows: { score: number; rationale: string }[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    rows.push(flat.slice(i * m, (i + 1) * m));
  }

  const candidateHashes = await Promise.all(candidates.map((c) => sha256(canonicalize(c))));

  // ── Per-candidate governed verdicts ──
  const verdicts: CandidateVerdict[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const row = rows[i];
    const lensVerdicts: LensVerdict[] = [];
    const affirmScores: number[] = [];
    const refuteScores: number[] = [];

    let hardKilled = false;
    let hardKillReason: string | null = null;
    let refuteFired = 0;
    let refuteGating = 0;

    for (let j = 0; j < m; j++) {
      const lens = lenses[j];
      const { score, rationale } = row[j];
      const fired = lens.polarity === "affirm" ? score < voteThreshold : score >= voteThreshold;

      lensVerdicts.push({
        lens: lens.verifier.name,
        polarity: lens.polarity,
        criticality: lens.criticality,
        engine: lens.signature.engine,
        rawScore: score,
        fired,
        rationale,
      });

      if (lens.criticality === "advisory") continue; // logged only; never gates

      if (lens.polarity === "affirm") {
        affirmScores.push(score);
        if (lens.criticality === "hard" && fired && !hardKilled) {
          hardKilled = true;
          hardKillReason = `hard affirm lens "${lens.verifier.name}" withheld approval (score ${score} < ${voteThreshold})`;
        }
      } else {
        refuteScores.push(score);
        refuteGating += 1;
        if (fired) refuteFired += 1;
        if (lens.criticality === "hard" && fired && !hardKilled) {
          hardKilled = true;
          hardKillReason = `hard refute lens "${lens.verifier.name}" fired (score ${score} >= ${voteThreshold})`;
        }
      }
    }

    // A quorum needs >=2 refute lenses; a strict majority firing ⇒ fail-closed kill.
    // A lone refuter must be `hard` to kill on its own; one soft refuter only discounts.
    const quorumKilled = refuteGating >= 2 && refuteFired * 2 > refuteGating;
    const killed = hardKilled || quorumKilled;
    const killReason = hardKilled
      ? hardKillReason
      : quorumKilled
        ? `refute quorum: ${refuteFired}/${refuteGating} refute lenses fired`
        : null;

    const affirmMean = affirmScores.length > 0 ? mean(affirmScores) : 1;
    const refuteMean = refuteScores.length > 0 ? mean(refuteScores) : 0;
    const compositeScore = clamp01(affirmMean * (1 - refuteMean));

    verdicts.push({
      candidateIndex: i,
      candidateHash: candidateHashes[i],
      lensVerdicts,
      killed,
      killReason,
      compositeScore,
    });
  }

  // ── Select: argmax composite among survivors (ties ⇒ lowest index) ──
  let acceptedIndex: number | null = null;
  let acceptedScore: number | null = null;
  for (const v of verdicts) {
    if (v.killed) continue;
    if (acceptedIndex === null || v.compositeScore > (acceptedScore as number)) {
      acceptedIndex = v.candidateIndex;
      acceptedScore = v.compositeScore;
    }
  }
  const accepted = acceptedIndex === null ? null : candidates[acceptedIndex];
  const acceptedHash = acceptedIndex === null ? null : candidateHashes[acceptedIndex];

  // ── Completeness: every non-accepted candidate retained with a reason ──
  const rejected: RejectedCandidate[] = [];
  for (const v of verdicts) {
    if (v.candidateIndex === acceptedIndex) continue;
    const reason = v.killed
      ? `killed: ${v.killReason}`
      : `not-selected: composite ${v.compositeScore} < accepted ${acceptedScore}`;
    rejected.push({
      candidateIndex: v.candidateIndex,
      candidateHash: v.candidateHash,
      reason,
    });
  }

  // ── Audit step: outputHash binds the whole governed decision ──
  const decisionCore = {
    kind: "verifier-battery",
    adrEco,
    voteThreshold,
    acceptedIndex,
    acceptedHash,
    acceptedScore,
    verdicts,
    rejected,
  };
  const outputHash = await sha256(canonicalize(decisionCore));

  const lensDescriptors = lenses.map((l) => ({
    name: l.verifier.name,
    polarity: l.polarity,
    criticality: l.criticality,
    engine: l.signature.engine,
    ...(l.signature.model !== undefined ? { model: l.signature.model } : {}),
  }));
  const inputHash = await sha256(
    canonicalize({
      kind: "verifier-battery",
      input,
      candidateHashes,
      lenses: lensDescriptors,
      voteThreshold,
      adrEco,
    }),
  );

  const end = clock.now();
  const auditStep: BatteryTraceStep = {
    runId,
    phase: "guard",
    type: "guard_check",
    guardName: VERIFIER_BATTERY_GUARD,
    timestamp: start,
    durationMs: end - start,
    inputHash,
    outputHash,
    policy: "hash-only",
  };

  return {
    accepted,
    acceptedIndex,
    acceptedHash,
    acceptedScore,
    verdicts,
    rejected,
    adrEco,
    voteThreshold,
    auditStep,
  };
}
