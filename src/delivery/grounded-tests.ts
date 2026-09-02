/**
 * delivery/grounded-tests.ts
 *
 * Really executes the stage's declared test command, so an execution-grounded
 * anchor (ci-green / ci-e2e-green / pass-count) reports a REAL exit code instead
 * of the producer's self-reported `ci_passed`. This is what closes the
 * v1-attestation hole: no self-attestation, no `ci_passed:true` shortcut.
 *
 * It also enforces the B3 commit binding: before any test runs, the worktree's
 * actual git HEAD must match the commit declared in the signed envelope, so the
 * producer cannot claim to have tested a commit other than the one being gated.
 *
 * Both the test command and the git command go through injected {@link ExecFn}s,
 * never a subprocess API directly; the real spawn-backed implementations live in
 * `node-exec.ts`.
 *
 * @module delivery/grounded-tests
 */

import { parseJson } from "./artifact-json.js";
import type { ExecFn, ExecResult, GroundedTestResult } from "./types.js";

/** First capture group of the first matching pattern, as an int ; undefined when none matched. */
function firstCount(output: string, patterns: readonly RegExp[]): number | undefined {
  for (const re of patterns) {
    const m = re.exec(output);
    if (m?.[1] !== undefined) {
      return Number.parseInt(m[1], 10);
    }
  }
  return undefined;
}

/**
 * Parse a test summary for pass/fail counts (best-effort). Handles both the
 * vitest/jest style ("N passed" / "N failed") and the node:test TAP style
 * ("# pass N" / "# fail N"). The exit code is the authoritative pass/fail
 * signal; these counts feed the pass-count anchor + the rationale.
 *
 * `collected` and `skipped` are reported ONLY when the runner states them
 * explicitly (node:test `# tests N` / `# skipped N`, pytest `collected N items`
 * / `N skipped`, jest `N total`). They stay `undefined` otherwise: deriving
 * collected as pass+fail+skip would fabricate exactly the figure a monotonicity
 * check needs to be true, and a fabricated baseline is worse than a missing one.
 */
function parseTestCounts(output: string): {
  pass: number;
  fail: number;
  collected?: number;
  skipped?: number;
} {
  const pass = firstCount(output, [/#\s*pass\s+(\d+)/i, /(\d+)\s+passed/i]);
  const fail = firstCount(output, [/#\s*fail\s+(\d+)/i, /(\d+)\s+failed/i]);
  const collected = firstCount(output, [
    /#\s*tests\s+(\d+)/i,
    /collected\s+(\d+)\s+items?/i,
    /(\d+)\s+total/i,
  ]);
  const skipped = firstCount(output, [/#\s*skipped\s+(\d+)/i, /(\d+)\s+skipped/i]);
  return {
    pass: pass ?? 0,
    fail: fail ?? 0,
    ...(collected === undefined ? {} : { collected }),
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * B3: Verify that the worktree's actual git HEAD matches the declared commit in
 * the envelope. Uses the injected exec function to run `git rev-parse HEAD`
 * with shell:false (via the existing ExecFn seam). The declared commit may be a
 * full SHA or a prefix; the check passes when HEAD starts with the declared
 * value or the declared value starts with HEAD (both directions for short-sha
 * compat). On git error or mismatch the result is fail-closed.
 *
 * The caller guarantees `declaredCommit` is a real (non-empty, non-"unknown")
 * value before calling. Returns null when the worktree HEAD matches. Returns a
 * GroundedTestResult with ran:false on mismatch or git error (the caller
 * returns this directly as the gate result).
 */
function verifyWorktreeCommit(
  worktree: string,
  declaredCommit: string,
  exec: ExecFn,
): GroundedTestResult | null {
  let gitResult: ExecResult;
  try {
    gitResult = exec("git rev-parse HEAD", worktree);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale: `B3 commit binding: git rev-parse HEAD threw (fail-closed): ${msg}`,
    };
  }
  if (gitResult.exitCode !== 0) {
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale: `B3 commit binding: git rev-parse HEAD failed (exit ${gitResult.exitCode}) in worktree ${worktree} (fail-closed)`,
    };
  }
  const actualHead = gitResult.stdout.trim();
  const declared = declaredCommit.trim();
  // Allow prefix match in either direction (short SHA vs full SHA).
  const matches =
    actualHead === declared || actualHead.startsWith(declared) || declared.startsWith(actualHead);
  if (!matches) {
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale: `B3 commit binding: worktree HEAD (${actualHead}) does not match declared commit (${declared}) (fail-closed)`,
    };
  }
  return null; // match confirmed; proceed
}

/**
 * Really execute the stage artifact's declared test command. The artifact (a
 * JSON object) MUST carry `worktree` (abs path) and `test_cmd` (shell string).
 * Returns ran:false when no executor is wired or the artifact does not declare a
 * command — in which case every execution-grounded anchor FAILS CLOSED. A seal
 * can never be granted on an unrun test: no self-attestation, no
 * `ci_passed:true` shortcut. This closes the v1-attestation hole.
 *
 * B3: When the artifact declares a `commit` field (or when `envelopeCommit` is
 * supplied), the worktree's actual git HEAD is verified against it before the
 * tests run. A mismatch or git error fails closed (no test run, anchor denied).
 * This applies in both mono-envelope and drift modes.
 */
export function runGroundedTests(
  artifact: string,
  exec: ExecFn | undefined,
  envelopeCommit?: string,
  // The B3 commit-binding check runs `git rev-parse HEAD`, which is a
  // gate-INTERNAL command (not the producer's test_cmd). It MUST NOT go through
  // the test-runner allowlist executor (which rejects `git` as "not in the
  // allowed test-runner set"), or B3 fails closed and ci-* can never pass for a
  // code stage. Route B3 through this git-capable executor; the producer's
  // test_cmd still runs through the allowlisted `exec`. Defaults to `exec` for
  // back-compat when no git executor is supplied (e.g. unit tests with a mock).
  gitExec?: ExecFn | undefined,
): GroundedTestResult {
  if (!exec) {
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale: "no executor wired: cannot ground ci anchor (fail-closed)",
    };
  }
  const o = parseJson(artifact);
  const testCmd = o && typeof o["test_cmd"] === "string" ? o["test_cmd"] : "";
  const worktree = o && typeof o["worktree"] === "string" ? o["worktree"] : "";
  if (!testCmd.trim() || !worktree.trim()) {
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale:
        "artifact must declare non-empty worktree + test_cmd for an execution-grounded anchor (fail-closed)",
    };
  }
  // B3: bind the worktree's actual HEAD to the declared commit before running
  // tests. The envelope commit takes precedence over the artifact's own
  // `commit` field (the envelope is signed and verifier-controlled). This
  // function only runs for execution-grounded stages, so a missing/empty/
  // "unknown" commit is fail-closed: you cannot trust a grounded test run that
  // is not bound to a verifiable commit.
  const declaredCommit = (
    envelopeCommit ?? (o && typeof o["commit"] === "string" ? o["commit"] : "")
  ).trim();
  if (!declaredCommit || declaredCommit === "unknown") {
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale:
        "execution-grounded stage requires a verifiable commit binding (B3) ; none supplied",
    };
  }
  const commitCheck = verifyWorktreeCommit(worktree, declaredCommit, gitExec ?? exec);
  if (commitCheck !== null) {
    return commitCheck;
  }
  let res: ExecResult;
  try {
    res = exec(testCmd, worktree);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ran: false,
      exitCode: -1,
      passCount: 0,
      failCount: 0,
      rationale: `executor threw (fail-closed): ${msg}`,
    };
  }
  const combined = `${res.stdout}\n${res.stderr}`;
  const counts = parseTestCounts(combined);
  // On failure, append the SPECIFIC failing-test detail (TAP "not ok" lines +
  // assertion message) so the affirm-lens feedback can hand the producer WHAT to
  // fix, not just "N failed". Without this the producer gets only counts and
  // cannot converge (it re-emits the same near-correct code every attempt,
  // blocking the stage at e.g. "6 passed, 1 failed" on all 3 attempts). The
  // detail is truncated and rides the signed rationale (diagnostic data).
  const failureDetail = res.exitCode !== 0 ? extractTestFailureDetail(combined) : "";
  const collectedPhrase = counts.collected === undefined ? "" : `, ${counts.collected} collected`;
  const skippedPhrase = counts.skipped === undefined ? "" : `, ${counts.skipped} skipped`;
  return {
    ran: true,
    exitCode: res.exitCode,
    passCount: counts.pass,
    failCount: counts.fail,
    ...(counts.collected === undefined ? {} : { collectedCount: counts.collected }),
    ...(counts.skipped === undefined ? {} : { skipCount: counts.skipped }),
    rationale:
      `ran '${testCmd}' in ${worktree} -> exit ${res.exitCode} ` +
      `(${counts.pass} passed, ${counts.fail} failed${collectedPhrase}${skippedPhrase})` +
      (failureDetail ? ` ; failing test detail: ${failureDetail}` : ""),
  };
}

/**
 * Extract the salient failing-test lines from a test runner's output (node:test
 * TAP, vitest, jest, pytest). Picks the failing-assertion signal lines (not ok,
 * AssertionError, expected/actual, error code, the failing test location) and
 * truncates to a bounded snippet so the producer gets the concrete failure to
 * fix without bloating the signed rationale.
 */
export function extractTestFailureDetail(output: string): string {
  const lines = output.split("\n");
  const signal =
    /\bnot ok\b|AssertionError|✖|✗|FAIL\b|Error:|expected:|actual:|ERR_TEST_FAILURE|expected .* to|received|at .*\.test\./i;
  const picked: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (signal.test(line)) {
      picked.push(line);
      if (picked.length >= 12) break;
    }
  }
  const snippet = (picked.length > 0 ? picked.join(" | ") : output.trim())
    .replace(/\s+/g, " ")
    .slice(0, 700);
  return snippet;
}
