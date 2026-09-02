/**
 * Eval runner + CI gate (audit Phase 5).
 *
 * runEval turns a curated golden dataset into a metrics report (pass^k / pass@k,
 * end-to-end success, LLM-judge calibration) using the pure primitives in
 * ./metrics. gateEval checks a report against CI thresholds and names every metric
 * that fell below its floor, so the tiered CI gate (PR / model-change / prod
 * sampling) is a thin wrapper over this deterministic core.
 *
 * Both functions are PURE (no clock, no IO). The dataset is "curated": each case
 * carries the attempt counts (c of n attempts passed the deterministic checks),
 * optionally the end-to-end run outcome, and optionally a (judge, gold) pair for
 * calibration. Sampling/replay that produces those counts lives upstream (offline,
 * not in the gate) so the gate stays fast and deterministic.
 */

import {
  type AttemptCounts,
  type ConfusionMatrix,
  confusionMatrix,
  meanPassAtK,
  meanPassHatK,
  successRate,
} from "./metrics.js";

/** One curated golden-dataset case. */
export interface EvalCase {
  readonly id: string;
  /** c of n sampled attempts passed the deterministic checks (drives pass^k / pass@k). */
  readonly attempts: AttemptCounts;
  /** end-to-end run outcome (whole run sealed); omit for cases that are not run-level. */
  readonly endToEnd?: boolean;
  /** for judge-calibration cases: the LLM-judge verdict and the human gold verdict. */
  readonly judge?: { readonly verdict: boolean; readonly gold: boolean };
  /** optional labels for slicing reports (e.g. stage, template, category). */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface EvalReport {
  readonly total: number;
  /** the k used for pass^k / pass@k (every case must have n >= k). */
  readonly k: number;
  readonly passHatK: number;
  readonly passAtK: number;
  /** mean end-to-end success over the cases that carry an endToEnd outcome (0 if none). */
  readonly endToEndSuccessRate: number;
  /** judge calibration over cases that carry a (judge, gold) pair; null if none. */
  readonly judgeCalibration: ConfusionMatrix | null;
}

/**
 * Aggregate a curated golden dataset into a metrics report. Throws (via the metric
 * primitives) if any case has n < k. An empty dataset yields zeros and a null
 * calibration.
 */
export function runEval(cases: readonly EvalCase[], k: number): EvalReport {
  const attempts = cases.map((c) => c.attempts);
  const e2e = cases.filter((c) => c.endToEnd !== undefined).map((c) => c.endToEnd as boolean);
  const judged = cases.filter(
    (c): c is EvalCase & { judge: { verdict: boolean; gold: boolean } } => c.judge !== undefined,
  );
  const judgeCalibration =
    judged.length > 0
      ? confusionMatrix(
          judged.map((c) => c.judge.verdict),
          judged.map((c) => c.judge.gold),
        )
      : null;
  return {
    total: cases.length,
    k,
    passHatK: meanPassHatK(attempts, k),
    passAtK: meanPassAtK(attempts, k),
    endToEndSuccessRate: successRate(e2e),
    judgeCalibration,
  };
}

/** CI floors. An absent threshold is not checked. */
export interface EvalThresholds {
  readonly minPassHatK?: number;
  readonly minEndToEndSuccess?: number;
  /** only enforced when the report has judge-calibration data. */
  readonly minJudgeKappa?: number;
}

export interface GateResult {
  readonly pass: boolean;
  /** one human-readable line per metric that fell below its floor (empty on pass). */
  readonly failures: readonly string[];
}

/**
 * Check a report against CI thresholds. A judge-kappa floor is skipped (not failed)
 * when the dataset has no calibration data: gating on absent data would block a
 * change for a dataset-completeness reason rather than a quality regression.
 */
export function gateEval(report: EvalReport, thresholds: EvalThresholds): GateResult {
  const failures: string[] = [];
  if (thresholds.minPassHatK !== undefined && report.passHatK < thresholds.minPassHatK) {
    failures.push(`pass^k ${report.passHatK.toFixed(4)} < min ${thresholds.minPassHatK}`);
  }
  if (
    thresholds.minEndToEndSuccess !== undefined &&
    report.endToEndSuccessRate < thresholds.minEndToEndSuccess
  ) {
    failures.push(
      `end-to-end success ${report.endToEndSuccessRate.toFixed(4)} < min ${thresholds.minEndToEndSuccess}`,
    );
  }
  if (
    thresholds.minJudgeKappa !== undefined &&
    report.judgeCalibration !== null &&
    report.judgeCalibration.kappa < thresholds.minJudgeKappa
  ) {
    failures.push(
      `judge kappa ${report.judgeCalibration.kappa.toFixed(4)} < min ${thresholds.minJudgeKappa}`,
    );
  }
  return { pass: failures.length === 0, failures };
}
