/**
 * rigor-score/pillars : the 3 honestly-scored RigorBench-inspired pillar
 * functions (wave-2 MOVE#9). Pure, synchronous, zero I/O, zero LLM ; every
 * function is a deterministic fold over already-observed data (a turn's own
 * tool calls, or its verify-before-done evidence/gap counts).
 *
 * Zero-data edge cases (no checks derived, no tool calls, no failures, no
 * edit_file calls) are scored as a VACUOUS PASS (1), mirroring
 * turn-verifier.ts's own `runChecks([])` convention ("no verifiable actions"
 * is not a penalty). A sub-metric with nothing to judge does not drag the
 * pillar down.
 *
 * @module rigor-score/pillars
 * @public @experimental
 */

import { canonicalize } from "../trace/canonical.js";
import type { ScoredToolCall } from "./types.js";

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ─── Verification Coverage ───────────────────────────────────────────────────

/**
 * evidenceCount / (evidenceCount + gapCount). Zero checks derived (both
 * counts 0) is a vacuous pass (1), matching turn-verifier.ts's
 * `runChecks([])` convention.
 * @public @experimental
 */
export function verificationCoverage(evidenceCount: number, gapCount: number): number {
  const total = evidenceCount + gapCount;
  if (total <= 0) return 1;
  return clamp01(evidenceCount / total);
}

// ─── Recovery Efficiency ─────────────────────────────────────────────────────

/**
 * Deterministic args-equality via the SDK's own RFC 8785 canonicalizer (the
 * same one `runVerifierBattery` hashes candidates with). A canonicalize
 * failure (non-serializable args) is treated as "not equal" rather than
 * thrown ; pillar math must never crash a turn's score.
 */
function sameCall(a: ScoredToolCall, b: ScoredToolCall): boolean {
  if (a.name !== b.name) return false;
  try {
    return canonicalize(a.args) === canonicalize(b.args);
  } catch {
    return false;
  }
}

const DOOM_LOOP_THRESHOLD = 3;

/** True once the same (name, args) pair repeats DOOM_LOOP_THRESHOLD times consecutively. */
function hasDoomLoop(toolCalls: readonly ScoredToolCall[]): boolean {
  let streak = 1;
  for (let i = 1; i < toolCalls.length; i++) {
    if (sameCall(toolCalls[i], toolCalls[i - 1])) {
      streak += 1;
      if (streak >= DOOM_LOOP_THRESHOLD) return true;
    } else {
      streak = 1;
    }
  }
  return false;
}

function isFailedRunBash(call: ScoredToolCall): boolean {
  return (
    call.name === "run_bash" && call.observedExitCode !== undefined && call.observedExitCode !== 0
  );
}

/**
 * 0.5 * loopFreedom + 0.5 * errorRecovery.
 *
 * loopFreedom is 0 when the same (name, args) call repeats >= 3 times
 * consecutively anywhere in the turn, else 1.
 *
 * errorRecovery is the fraction of observed run_bash failures (that have a
 * following call to judge) whose next call is NOT identical (name + args) to
 * the failing one ; i.e. the agent tried something different rather than
 * blindly repeating the same failing action. A failure with no following
 * call (it was the turn's last action) is not counted here ; that is
 * `atomicTransitionIntegrity`'s `endedClean` sub-metric's concern. No
 * judgeable failures is a vacuous pass (1).
 * @public @experimental
 */
export function recoveryEfficiency(toolCalls: readonly ScoredToolCall[]): number {
  const loopFreedom = hasDoomLoop(toolCalls) ? 0 : 1;

  let recoverable = 0;
  let recovered = 0;
  for (let i = 0; i < toolCalls.length - 1; i++) {
    if (isFailedRunBash(toolCalls[i])) {
      recoverable += 1;
      if (!sameCall(toolCalls[i], toolCalls[i + 1])) recovered += 1;
    }
  }
  const errorRecovery = recoverable === 0 ? 1 : recovered / recoverable;

  return clamp01(0.5 * loopFreedom + 0.5 * errorRecovery);
}

// ─── Atomic Transition Integrity ─────────────────────────────────────────────

function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 0.5 * readBeforeEdit + 0.5 * endedClean.
 *
 * readBeforeEdit is the fraction of edit_file calls whose target path
 * (args.filePath) was read (a read_file call with the SAME args.path)
 * earlier in the turn. Zero edit_file calls is a vacuous pass (1).
 *
 * endedClean is 0 only when the turn's LAST call is a run_bash call with an
 * OBSERVED non-zero exit code ; an unobserved exit code is unverifiable, not
 * guilty (mirrors turn-verifier.ts's own "unverifiable without re-running"
 * treatment), so it does not count as a dirty ending. Zero tool calls is a
 * vacuous pass (1).
 * @public @experimental
 */
export function atomicTransitionIntegrity(toolCalls: readonly ScoredToolCall[]): number {
  let editCount = 0;
  let editsWithPriorRead = 0;
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (call.name !== "edit_file") continue;
    editCount += 1;
    const path = stringField(call.args, "filePath");
    if (path === undefined) continue;
    const readEarlier = toolCalls
      .slice(0, i)
      .some((c) => c.name === "read_file" && stringField(c.args, "path") === path);
    if (readEarlier) editsWithPriorRead += 1;
  }
  const readBeforeEdit = editCount === 0 ? 1 : editsWithPriorRead / editCount;

  const last = toolCalls[toolCalls.length - 1];
  const endedClean = last !== undefined && isFailedRunBash(last) ? 0 : 1;

  return clamp01(0.5 * readBeforeEdit + 0.5 * endedClean);
}
