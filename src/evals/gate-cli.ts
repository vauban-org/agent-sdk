/**
 * Runnable eval gate (audit Phase 5 ; tiered CI gating).
 *
 * The deterministic core a CI step runs: load a curated golden dataset (untrusted
 * JSON), validate it at the boundary, score it (runEval), gate it (gateEval), and
 * render a summary. Pure (no fs, no process, no clock) so it is fully
 * unit-testable; the workflow supplies the file read, the thresholds, and the exit
 * code (0 on pass, 1 on fail).
 */

import {
  type EvalCase,
  type EvalReport,
  type EvalThresholds,
  type GateResult,
  gateEval,
  runEval,
} from "./report.js";

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

const CASE_KEYS = new Set(["id", "attempts", "endToEnd", "judge", "tags"]);

function parseCase(raw: unknown, index: number): EvalCase {
  const where = `eval dataset case[${index}]`;
  const o = asObject(raw, where);
  for (const key of Object.keys(o)) {
    if (!CASE_KEYS.has(key)) {
      throw new TypeError(`${where}: unknown key "${key}" (strict)`);
    }
  }
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new TypeError(`${where}: "id" must be a non-empty string`);
  }
  const att = asObject(o.attempts, `${where}: "attempts"`);
  const n = att.n;
  const c = att.c;
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(c) ||
    Object.keys(att).some((k) => k !== "n" && k !== "c")
  ) {
    throw new TypeError(`${where}: "attempts" must be { n: int, c: int }`);
  }
  const result: {
    id: string;
    attempts: { n: number; c: number };
    endToEnd?: boolean;
    judge?: { verdict: boolean; gold: boolean };
    tags?: Record<string, string>;
  } = { id: o.id, attempts: { n: n as number, c: c as number } };

  if (o.endToEnd !== undefined) {
    if (typeof o.endToEnd !== "boolean") {
      throw new TypeError(`${where}: "endToEnd" must be a boolean`);
    }
    result.endToEnd = o.endToEnd;
  }
  if (o.judge !== undefined) {
    const j = asObject(o.judge, `${where}: "judge"`);
    if (typeof j.verdict !== "boolean" || typeof j.gold !== "boolean") {
      throw new TypeError(`${where}: "judge" must be { verdict: boolean, gold: boolean }`);
    }
    result.judge = { verdict: j.verdict, gold: j.gold };
  }
  if (o.tags !== undefined) {
    const t = asObject(o.tags, `${where}: "tags"`);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(t)) {
      if (typeof v !== "string") {
        throw new TypeError(`${where}: tags["${k}"] must be a string`);
      }
      tags[k] = v;
    }
    result.tags = tags;
  }
  return result;
}

/** Validate an untrusted golden-dataset JSON into EvalCase[]. Throws on malformed input. */
export function parseEvalDataset(json: unknown): EvalCase[] {
  if (!Array.isArray(json)) {
    throw new TypeError("eval dataset must be a JSON array of cases");
  }
  return json.map((raw, i) => parseCase(raw, i));
}

export interface GateRunResult {
  readonly report: EvalReport;
  readonly gate: GateResult;
}

/** Parse + score + gate a golden dataset. The runnable core of the CI gate. */
export function runGateFromDataset(
  json: unknown,
  opts: { k: number; thresholds: EvalThresholds },
): GateRunResult {
  const cases = parseEvalDataset(json);
  const report = runEval(cases, opts.k);
  const gate = gateEval(report, opts.thresholds);
  return { report, gate };
}

/** Render a human-readable CI summary of a gate run. */
export function formatGateReport(result: GateRunResult): string {
  const { report, gate } = result;
  const kappa = report.judgeCalibration === null ? "n/a" : report.judgeCalibration.kappa.toFixed(4);
  const lines = [
    `[delivery-eval] GATE ${gate.pass ? "PASS" : "FAIL"}  (k=${report.k}, ${report.total} cases)`,
    `  pass^k:      ${report.passHatK.toFixed(4)}`,
    `  pass@k:      ${report.passAtK.toFixed(4)}`,
    `  end-to-end:  ${report.endToEndSuccessRate.toFixed(4)}`,
    `  judge kappa: ${kappa}`,
  ];
  for (const failure of gate.failures) {
    lines.push(`  FAIL: ${failure}`);
  }
  return lines.join("\n");
}
