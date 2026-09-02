/**
 * orchestration/dag/best-of-n.ts ; Cap 1 — verifier-driven best-of-N.
 *
 * Two pure helpers that turn N cheap candidate outputs into one verified-best,
 * fail-closed. This is the model-agnostic quality wedge of the SOTA orchestration
 * engine (spec 2026-06-05): N cheap samples + a cheap deterministic verifier beat
 * one expensive sample.
 *
 *   - {@link bestOfN}: a thin adapter that runs a {@link Verifier} port over a set
 *     of candidates and returns its {@link VerifierVerdict}. Empty candidates →
 *     fail-closed (accepted null, acceptedIndex -1) WITHOUT invoking the verifier.
 *   - {@link batteryVerifier}: a factory that adapts `runVerifierBattery` (ADR-068)
 *     into the {@link Verifier} port. It enforces the ADR-068 four-properties
 *     invariants (mandatory deterministic non-llm-judge anchor; non-empty adrEco)
 *     and maps a {@link BatteryDecision} into a {@link VerifierVerdict}.
 *
 * PURE: no fs, no network, no Date.now. The only environmental read is the
 * injected ClockPort (consumed by runVerifierBattery), so a RecordedClock makes
 * the decision byte-identical on replay. Never imports packages/cli (preste).
 *
 * @module orchestration/dag/best-of-n
 * @since agent-sdk SOTA-orchestration v1
 */

import type { ClockPort } from "../../replay/clock.js";
import { runVerifierBattery } from "../../compute/battery/battery.js";
import type {
  BatteryLens,
  CandidateVerdict,
} from "../../compute/battery/types.js";
import type {
  DagNodeSpec,
  NodeInputs,
  Verifier,
  VerifierVerdict,
} from "./contracts.js";

/**
 * Selection policy applied to the survivors the battery approved (Cap 1.5).
 *
 *   - `"argmax"` ; plain best-of-N. Pick the single highest composite score.
 *     The historical default ; byte-identical to Cap 1.
 *   - `"mob"` ; Majority-of-the-Bests (arXiv 2511.18630). Bootstrap-resample the
 *     survivor set and pick the answer-VALUE that most robustly wins the per-
 *     resample argmax (the mode over answer hashes, not over sample indices).
 *     Hyperparameter-free, near-zero cost, fixes BoN's non-convergence under an
 *     imperfect reward: when many samples collapse to the same answer (discrete
 *     answer spaces ; a tool choice, a number, a yes/no, a short structured
 *     field), MoB selects the robust answer rather than a single lucky high score.
 *
 * IMPORTANT (honest scope ; two degeneration conditions):
 *   1. MoB groups candidates by `candidateHash` (sha256 of the canonical
 *      candidate). For DISCRETE-answer nodes many samples share a hash and MoB
 *      pays off. For FREE-TEXT nodes (open research prose) candidates are almost
 *      never byte-identical, every group has one member, and MoB degrades to
 *      argmax.
 *   2. MoB's documented "fixes non-convergence" gain assumes an IMPERFECT/NOISY
 *      reward. The ADR-068 battery anchor is DETERMINISTIC by mandate, so with
 *      distinct deterministic scores the bootstrap mode is always the global max
 *      = argmax. The realised benefit on this engine is therefore the narrower
 *      TIE / shared-answer case: when several survivors share the top score, MoB
 *      picks the most FREQUENT top answer instead of the first index.
 * It is never worse than argmax ; it only ever selects among the battery's
 * approved survivors (ADR-068 fail-closed preserved). Because the gain is narrow
 * on a deterministic anchor, MoB is OPT-IN, not the turnkey default (defaulting a
 * near-no-op on would be cargo-cult per ADR-068).
 *
 * @public
 */
export type SelectionPolicy = "argmax" | "mob";

/** Fixed bootstrap resample count for MoB. Not a tunable: kept constant so the
 *  policy stays "hyperparameter-free" per the paper and deterministic on replay. */
const MOB_BOOTSTRAP_ROUNDS = 1000;

/** FNV-1a 32-bit fold of a string → uint32 seed. Pure, sync, dependency-free.
 *  Cryptographic strength is irrelevant here (seeds a bootstrap PRNG, not a key). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. Deterministic, fast, good enough for bootstrap resampling. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Majority-of-the-Bests selection over the battery's SURVIVORS (killed = false).
 *
 * Returns the `candidateIndex` of the chosen survivor, or `null` when there is no
 * survivor. Deterministic: the bootstrap PRNG is seeded purely from `seedStr`
 * (caller passes a stable `runId|nodeId` string), so replay reproduces the exact
 * selection with no injected clock or RNG port.
 *
 * Algorithm (paper-faithful):
 *   1. Keep survivors only (the battery already enforced the ADR-068 anchor +
 *      threshold + quorum ; MoB never resurrects a killed candidate).
 *   2. ≤1 survivor → return it directly (bootstrap is a no-op).
 *   3. B bootstrap rounds: draw `k` survivors with replacement (k = #survivors);
 *      the round winner is the max-composite drawn survivor (ties → lowest index);
 *      tally the winner's `candidateHash` (the ANSWER, so identical answers from
 *      distinct samples accrue to one group).
 *   4. Winning answer = max tally (ties → higher representative score, then lower
 *      index). Return the highest-composite survivor carrying that answer hash.
 *
 * @public
 */
export function mobSelectIndex(
  verdicts: readonly CandidateVerdict[],
  seedStr: string,
  rounds: number = MOB_BOOTSTRAP_ROUNDS,
): number | null {
  const survivors = verdicts.filter((v) => !v.killed);
  if (survivors.length === 0) return null;
  if (survivors.length === 1) return survivors[0]!.candidateIndex;

  const rng = mulberry32(fnv1a32(seedStr));
  const k = survivors.length;
  const tally = new Map<string, number>(); // candidateHash → wins

  for (let b = 0; b < rounds; b++) {
    let best: CandidateVerdict | null = null;
    for (let d = 0; d < k; d++) {
      const pick = survivors[Math.floor(rng() * k)]!;
      if (
        // Strict `>` only: the FIRST drawn sample at the max score wins the
        // round. With identical scores this makes the round winner the first
        // top-score draw, so a more FREQUENT answer wins proportionally more
        // rounds — this is the answer-robustness MoB is built on. An index
        // tie-break here would instead always pick the lowest index and defeat
        // the frequency weighting (reducing MoB to argmax even on ties).
        best === null ||
        pick.compositeScore > best.compositeScore
      ) {
        best = pick;
      }
    }
    const hash = best!.candidateHash;
    tally.set(hash, (tally.get(hash) ?? 0) + 1);
  }

  // Representative (best instance) + max score per answer hash, for tie-breaks.
  const repByHash = new Map<string, CandidateVerdict>();
  for (const v of survivors) {
    const cur = repByHash.get(v.candidateHash);
    if (
      cur === undefined ||
      v.compositeScore > cur.compositeScore ||
      (v.compositeScore === cur.compositeScore &&
        v.candidateIndex < cur.candidateIndex)
    ) {
      repByHash.set(v.candidateHash, v);
    }
  }

  let winnerHash: string | null = null;
  let winnerWins = -1;
  for (const [hash, wins] of tally) {
    const rep = repByHash.get(hash)!;
    if (winnerHash === null) {
      winnerHash = hash;
      winnerWins = wins;
      continue;
    }
    const curRep = repByHash.get(winnerHash)!;
    if (
      wins > winnerWins ||
      (wins === winnerWins && rep.compositeScore > curRep.compositeScore) ||
      (wins === winnerWins &&
        rep.compositeScore === curRep.compositeScore &&
        rep.candidateIndex < curRep.candidateIndex)
    ) {
      winnerHash = hash;
      winnerWins = wins;
    }
  }

  return repByHash.get(winnerHash!)!.candidateIndex;
}

/** Fail-closed verdict for an empty candidate set (no verifier call). */
function emptyVerdict<TOutput>(): VerifierVerdict<TOutput> {
  return {
    accepted: null,
    acceptedIndex: -1,
    reason: "no candidates (fail-closed)",
  };
}

/**
 * Run a {@link Verifier} port over `candidates` and return its verdict.
 *
 * Thin and fail-closed: when `candidates` is empty the verifier is NOT invoked
 * (it would have nothing to rank, and ADR-068 batteries reject a zero-candidate
 * call); we return `{ accepted: null, acceptedIndex: -1 }` directly. Otherwise the
 * verifier's verdict is returned verbatim.
 *
 * @typeParam TOutput - shape of each candidate output.
 * @public
 */
export async function bestOfN<TOutput>(opts: {
  readonly candidates: readonly TOutput[];
  readonly verifier: Verifier<TOutput>;
  readonly node: DagNodeSpec;
  readonly inputs: NodeInputs;
}): Promise<VerifierVerdict<TOutput>> {
  const { candidates, verifier, node, inputs } = opts;
  if (candidates.length === 0) return emptyVerdict<TOutput>();
  return verifier(candidates, { node, inputs });
}

/** Options for {@link batteryVerifier}. */
export interface BatteryVerifierOptions<TOutput> {
  /** Governed lenses that judge each candidate (≥1 deterministic non-llm-judge anchor). */
  readonly lenses: readonly BatteryLens<TOutput>[];
  /** Governing ADR-ECO, forwarded to the battery. Mandatory non-empty (cargo-cult guard). */
  readonly adrEco: string;
  /** Clock for the audit step. RealClock in production, RecordedClock for replay. */
  readonly clock: ClockPort;
  /** Vote threshold in [0,1]; default 0.5 (battery default). */
  readonly voteThreshold?: number;
  /** Run id stamped on the audit step. Default "best-of-n"; pass the loop run id. */
  readonly runId?: string;
  /**
   * Selection policy over the battery's survivors (Cap 1.5). Default `"argmax"`
   * (byte-identical to Cap 1). `"mob"` = Majority-of-the-Bests, deterministic,
   * seeded from `runId|node`. See {@link SelectionPolicy}.
   */
  readonly selection?: SelectionPolicy;
}

/**
 * Adapt `runVerifierBattery` (ADR-068) into the {@link Verifier} port.
 *
 * The returned verifier builds a {@link BatteryDecision} over the candidate
 * outputs using the caller-supplied lenses, then maps `decision.accepted` →
 * {@link VerifierVerdict}. Fail-closed: when the battery kills every candidate
 * the verdict is `{ accepted: null, acceptedIndex: -1 }`.
 *
 * ADR-068 four-properties enforcement (rejected EAGERLY at factory time, before
 * any candidate exists, so a misconfigured gate fails fast):
 *   - non-empty `adrEco` (ADR-traceability);
 *   - at least one deterministic non-"llm-judge" lens (the mandatory anchor;
 *     a learned-verifier-only gate is hackable, arXiv:2603.06621).
 * The remaining invariants (≥1 candidate, ≥1 non-advisory lens, voteThreshold
 * range) are enforced by `runVerifierBattery` itself at call time and surface as
 * {@link BatteryGovernanceError}.
 *
 * Note on the gate signal: we read `acceptedIndex` (the survivor signal), not
 * `accepted` (the candidate VALUE, which can legitimately be `null`), so a
 * surviving `null` candidate is not mislabelled "all killed". The `VerifierVerdict`
 * carries the index plus the candidate value verbatim.
 *
 * @typeParam TOutput - shape of each candidate output.
 * @throws {Error} at factory time when adrEco is empty or no deterministic anchor lens is present.
 * @public
 */
export function batteryVerifier<TOutput>(
  opts: BatteryVerifierOptions<TOutput>,
): Verifier<TOutput> {
  const { lenses, adrEco, clock, voteThreshold } = opts;
  const runId = opts.runId ?? "best-of-n";
  const selection: SelectionPolicy = opts.selection ?? "argmax";

  // Eager ADR-068 guards (fail fast, before any run): adrEco + deterministic anchor.
  if (typeof adrEco !== "string" || adrEco.trim().length === 0) {
    throw new Error(
      "batteryVerifier: adrEco is mandatory (ADR-068 ADR-traceability invariant); " +
        "a verifier with no governing decision record is a cargo-cult gate",
    );
  }
  if (!lenses.some((l) => l.signature.engine !== "llm-judge")) {
    throw new Error(
      "batteryVerifier: at least one non-llm-judge lens is required " +
        "(ADR-068 deterministic anchor invariant; learned verifiers are hackable, arXiv:2603.06621)",
    );
  }

  return async (
    candidates: readonly TOutput[],
    ctx: { readonly node: DagNodeSpec; readonly inputs: NodeInputs },
  ): Promise<VerifierVerdict<TOutput>> => {
    // The battery rejects a zero-candidate call; short-circuit fail-closed instead.
    if (candidates.length === 0) return emptyVerdict<TOutput>();

    // `input` binds the node identity + resolved upstream inputs into the audit hash.
    const input = {
      node: ctx.node.id,
      task: ctx.node.task,
      inputs: ctx.inputs,
    };

    const decision = await runVerifierBattery<TOutput>(
      input,
      candidates,
      lenses,
      {
        clock,
        runId,
        adrEco,
        ...(voteThreshold !== undefined ? { voteThreshold } : {}),
      },
    );

    // Gate on acceptedIndex (the survivor signal), not accepted (the value).
    if (decision.acceptedIndex === null) {
      const why =
        decision.rejected.map((r) => r.reason).join("; ") ||
        "all candidates killed";
      return {
        accepted: null,
        acceptedIndex: -1,
        reason: `best-of-N: ${why} (fail-closed)`,
      };
    }

    // Cap 1.5: apply the selection policy over the SURVIVORS the battery
    // approved. `"argmax"` keeps the battery's own pick (byte-identical to Cap 1).
    // `"mob"` re-selects via Majority-of-the-Bests; it only ever returns a
    // survivor index, so the ADR-068 fail-closed/anchor guarantees are preserved.
    let idx = decision.acceptedIndex;
    let policyNote = "";
    if (selection === "mob") {
      const mobIdx = mobSelectIndex(
        decision.verdicts,
        `${runId}|${ctx.node.id}`,
      );
      if (mobIdx !== null) {
        idx = mobIdx;
        policyNote =
          mobIdx === decision.acceptedIndex
            ? " [mob=argmax]"
            : ` [mob; argmax was ${decision.acceptedIndex}]`;
      }
    }

    const chosen = decision.verdicts.find((v) => v.candidateIndex === idx);
    const score = chosen?.compositeScore ?? decision.acceptedScore;
    const scorePart =
      score !== null && score !== undefined ? ` (composite ${score})` : "";
    return {
      accepted: candidates[idx] as TOutput,
      acceptedIndex: idx,
      reason: `best-of-N: accepted candidate ${idx}${scorePart}${policyNote}`,
      ...(typeof score === "number" ? { acceptedScore: score } : {}),
    };
  };
}
