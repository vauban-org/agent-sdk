/**
 * compute/battery/types.ts
 *
 * VerifierBattery types ; a governed, provable rejection-sampling primitive.
 *
 * The battery steals the Atropos / Best-of-N technique ("generate N, verify all,
 * keep the best, discard the rest") and re-expresses it as a production control
 * WITH PROOF. Every run gains the four governance properties that separate a
 * Vauban primitive from a model-quality heuristic:
 *
 *   (1) Determinism      pure function of (input, candidates, lenses, clock seq).
 *                        No wall-clock and no crypto-random in the decision path.
 *   (2) Audit step       emits ONE TraceStep (phase "guard", type "guard_check")
 *                        whose outputHash = sha256(canonical(decision)). The host
 *                        trace chain folds it into rootHash for free; this module
 *                        never touches proof/chain.ts.
 *   (3) ADR traceability `adrEco` is mandatory at the call site. A battery with no
 *                        governing decision record is a cargo-cult gate and is
 *                        rejected before any work is done.
 *   (4) Replay           the audit step is reproducible: identical inputs plus an
 *                        identical recorded clock sequence reproduce a byte-identical
 *                        outputHash, hence an identical rootHash.
 *
 * The moat is the SEAM, not the parts: the reject-set is KEPT as proof (Atropos
 * discards it), every non-accepted candidate carries an auditable reason
 * (Completeness, EU AI Act Art. 12), and at least one deterministic non-gameable
 * lens is mandatory per gate (learned verifiers are hackable, arXiv:2603.06621).
 *
 * @module compute/battery/types
 */

import type { ClockPort } from "../../replay/clock.js";
import type { RandomPort } from "../../replay/random.js";
import type { TraceStep } from "../../trace/schema.js";
import type { Verifier } from "../verifier.js";

// ─── Lens ────────────────────────────────────────────────────────────────────

/**
 * Evaluation engine behind a lens. Drives the deterministic-anchor invariant:
 * a battery must carry at least one non-"llm-judge" lens so the gate cannot be
 * gamed by fooling a learned verifier (arXiv:2603.06621).
 * @public
 */
export type LensEngine =
  | "rule" // deterministic boolean/score rule (OPA/Rego-class). Non-gameable anchor.
  | "smt" // SMT / formal solver verdict (verify/formal). Deterministic.
  | "execution" // runs code or a tool and checks the result. Deterministic given inputs.
  | "retrieval" // checks against a retrieved corpus or allowlist.
  | "statistical" // threshold over a computed statistic.
  | "llm-judge"; // LLM-backed judge. Non-deterministic unless replayed; never a sole anchor.

/**
 * BatteryLens ; a Verifier dressed with governance metadata.
 *
 * - polarity "affirm": a HIGH score means "accept this candidate".
 * - polarity "refute": a HIGH score means "this candidate VIOLATES" and counts
 *   toward killing the candidate (refuters invert at the gate).
 * - criticality "hard": can single-handedly block acceptance or kill a candidate.
 *   "soft": contributes to the composite score only. "advisory": logged, no gating.
 * @public
 */
export interface BatteryLens<TOutput = unknown> {
  readonly verifier: Verifier<TOutput>;
  readonly polarity: "affirm" | "refute";
  readonly criticality: "hard" | "soft" | "advisory";
  readonly signature: {
    readonly engine: LensEngine;
    /** Model id when engine is "llm-judge" (telemetry plus replay-cache key). */
    readonly model?: string;
  };
}

// ─── Verdicts (the disagreement vector) ────────────────────────────────────────

/**
 * One lens's verdict on one candidate.
 * @public
 */
export interface LensVerdict {
  /** Verifier.name of the lens. */
  readonly lens: string;
  readonly polarity: "affirm" | "refute";
  readonly criticality: "hard" | "soft" | "advisory";
  readonly engine: LensEngine;
  /** Raw [0,1] score returned by the verifier. */
  readonly rawScore: number;
  /**
   * Whether this lens fired its GATING signal on this candidate:
   *   affirm  -> rawScore <  voteThreshold (affirmer withholds approval);
   *   refute  -> rawScore >= voteThreshold (refuter found a violation).
   * Advisory lenses still report `fired`, but it never gates.
   */
  readonly fired: boolean;
  readonly rationale: string;
}

/**
 * Governed verdict for one candidate across all lenses.
 * @public
 */
export interface CandidateVerdict {
  readonly candidateIndex: number;
  /** sha256(canonical(candidate)) ; GDPR-safe identity, no plaintext retained. */
  readonly candidateHash: string;
  readonly lensVerdicts: readonly LensVerdict[];
  /** True when a hard lens fired or a majority of refute lenses fired (fail-closed). */
  readonly killed: boolean;
  /** Human-readable kill cause (Art. 14), or null when the candidate survived. */
  readonly killReason: string | null;
  /** Monotone composite in [0,1] used to argmax among survivors. */
  readonly compositeScore: number;
}

/**
 * A non-accepted candidate retained as proof (Atropos discards this; we keep it).
 * @public
 */
export interface RejectedCandidate {
  readonly candidateIndex: number;
  readonly candidateHash: string;
  /** "killed: <lens> ..." or "not-selected: score X < accepted Y". */
  readonly reason: string;
}

// ─── Audit step ────────────────────────────────────────────────────────────────

/**
 * The single audit step the battery emits. It is a TraceStep stripped of its
 * chain-linkage fields (index, prevStepHash, stepHash), which the host trace
 * recorder assigns when it appends the step and runs buildChain. The battery is
 * a pure function and owns no chain position.
 * @public
 */
export type BatteryTraceStep = Omit<TraceStep, "index" | "prevStepHash" | "stepHash">;

// ─── Decision ──────────────────────────────────────────────────────────────────

/**
 * The full governed outcome of one battery run.
 * @public
 */
export interface BatteryDecision<TOutput = unknown> {
  /** Accepted candidate, or null when every candidate was killed (fail-closed). */
  readonly accepted: TOutput | null;
  readonly acceptedIndex: number | null;
  /** sha256(canonical(accepted)), or null. */
  readonly acceptedHash: string | null;
  readonly acceptedScore: number | null;
  /** Per-candidate governed verdicts (every candidate appears exactly once). */
  readonly verdicts: readonly CandidateVerdict[];
  /** Every non-accepted candidate with a reason (Completeness; reject-as-proof). */
  readonly rejected: readonly RejectedCandidate[];
  /** Governing decision record. Mandatory ; enforced at the call site. */
  readonly adrEco: string;
  /** Vote threshold in effect for this decision (bound into the audit hash). */
  readonly voteThreshold: number;
  /** The audit step whose outputHash = sha256(canonical(decision core)). */
  readonly auditStep: BatteryTraceStep;
}

// ─── Context plus options ────────────────────────────────────────────────────

/**
 * VerifierCtx ; virtualised non-determinism ports shared by all governed
 * primitives. The deterministic battery core consumes only `clock`; `random`
 * is reserved for sampling or llm-judge lenses wired through the replay cache.
 * @public
 */
export interface VerifierCtx {
  readonly clock: ClockPort;
  readonly random?: RandomPort;
  /** True under recorded (replay) ports. Advisory ; the core stays deterministic. */
  readonly recorded?: boolean;
}

/**
 * Call options for {@link runVerifierBattery}.
 * @public
 */
export interface RunVerifierBatteryOptions extends VerifierCtx {
  /** Run identifier stamped on the audit step (anti-splice AR6). */
  readonly runId: string;
  /** Governing ADR-ECO. Mandatory non-empty (cargo-cult guard). */
  readonly adrEco: string;
  /** Vote threshold in [0,1]; default 0.5. A lens fires at or over it. */
  readonly voteThreshold?: number;
  readonly signal?: AbortSignal;
}
