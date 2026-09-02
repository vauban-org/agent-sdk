/**
 * run-state.ts ; L0 execution-state substrate (RunStatePort + trace projections).
 *
 * THE KEYSTONE: graph-viz, breakpoint, state-injection and time-travel are NOT
 * four features ; they are four read/fork PROJECTIONS of ONE immutable Trace
 * (the `TraceStep` chain). RunStatePort is a thin VIEW over that trace ; it NEVER
 * builds a second state model and NEVER mutates the trace. A fork mints a new
 * prefix, leaving the parent byte-identical ; the immutability invariant the
 * time-travel and state-injection adapters rely on.
 *
 * This module ships the facade + three pure projections (graph-viz, breakpoint,
 * state-injection). The live-loop breakpoint pause and the deterministic replay
 * wiring (`replayFrom` / `RecordedClock`) are thin adapters over the SAME port,
 * left to the loop seam so a breakpoint reuses the existing HITL machinery rather
 * than introducing a new block.
 *
 * Promoted into the published SDK per ADR-ECO-101 (W2 GATE). L1 evidence: the BTC
 * best-execution pilot (command-center apps/agents/btc-execution, commit 4312fff3
 * ; the W2 RunStatePort unit contract). Reusable by any agent over a TraceStep
 * chain.
 */

import type { TraceStep } from "./schema.js";

/** A thin read/fork view over an immutable trace (the TraceStep chain). */
export interface RunStatePort {
  /** Read steps [0, toStep) ; the whole trace when `toStep` is omitted. Read-only. */
  readPrefix(toStep?: number): readonly TraceStep[];
  /** Fork at step N: a NEW prefix [0, N). The parent trace is NEVER mutated. */
  forkAt(toStep: number): readonly TraceStep[];
  /** Chain head = the last step's `stepHash` (empty string for an empty trace). */
  headHash(): string;
}

/** A read/fork view over an in-memory TraceStep array (the trace). */
export function inMemoryRunState(steps: readonly TraceStep[]): RunStatePort {
  // Defensive copy: the view cannot be mutated through the caller's reference.
  const frozen = [...steps];
  return {
    readPrefix(toStep) {
      const end = toStep ?? frozen.length;
      return frozen.slice(0, Math.max(0, end));
    },
    forkAt(toStep) {
      return frozen.slice(0, Math.max(0, toStep));
    },
    headHash() {
      return frozen.length === 0 ? "" : frozen[frozen.length - 1].stepHash;
    },
  };
}

const PHASE_SHORT: Record<TraceStep["phase"], string> = {
  observe: "OBS",
  orient: "ORI",
  decide: "DEC",
  act: "ACT",
  feedback: "FB",
  guard: "GRD",
  hitl: "HITL",
};

/**
 * Projection #1 ; graph-viz: render a trace prefix as a Mermaid flowchart. Pure
 * function of the steps (deterministic, no clock). Nodes = steps (phase:type),
 * edges = the prevStepHash -> stepHash chain order.
 */
export function traceToMermaid(steps: readonly TraceStep[]): string {
  const lines = ["flowchart TD"];
  for (const s of steps) {
    lines.push(`  s${s.index}["#${s.index} ${PHASE_SHORT[s.phase]}:${s.type}"]`);
  }
  for (let i = 1; i < steps.length; i++) {
    lines.push(`  s${steps[i - 1].index} --> s${steps[i].index}`);
  }
  return lines.join("\n");
}

/**
 * Projection #2 ; breakpoint: the index of the first step matching `predicate`
 * (the pause point), or null if none. Pure ; the live-loop pause is a thin
 * adapter that awaits the existing HITL channel when this fires (deferred to the
 * loop seam, so a breakpoint reuses the HITL machinery ; it is not a new block).
 */
export function findBreakpoint(
  steps: readonly TraceStep[],
  predicate: (step: TraceStep) => boolean,
): number | null {
  for (const s of steps) {
    if (predicate(s)) return s.index;
  }
  return null;
}

/**
 * Projection #3 ; state-injection: fork at step N and append a synthetic step
 * carrying an operator delta. Returns a NEW prefix ; the parent trace is NEVER
 * mutated (injection = fork, not edit). A persistent fork mints a fresh runId
 * whose genesis embeds the parent rootHash (provenance, not erasure).
 */
export function injectAt(
  steps: readonly TraceStep[],
  toStep: number,
  injected: TraceStep,
): readonly TraceStep[] {
  return [...steps.slice(0, Math.max(0, toStep)), injected];
}
