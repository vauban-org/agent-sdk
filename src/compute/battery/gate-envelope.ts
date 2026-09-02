/**
 * compute/battery/gate-envelope.ts
 *
 * Signed gate-verdict envelope for the Vauban Delivery Control Plane.
 *
 * WHY THIS EXISTS (the keystone). `batteryActionGate` returns an UNSIGNED verdict
 * whose `outputHash` binds the artifact hash but not the run/stage, and it does
 * not return the `decisionCore` a control plane needs to recompute that hash. A
 * control plane that merely recomputes a hash proves NON-MUTATION, not
 * AUTHENTICITY, and verdict-write + status-flip are two transactions (TOCTOU).
 * This module wraps a `BatteryDecision` into a tamper-evident, replay-resistant,
 * verifier-signed envelope the macro (Citadel) verifies in the same transaction
 * that seals a stage.
 *
 * TRUST MODEL (v1, mono-tenant). The envelope is signed by the VERIFIER (a distinct
 * identity from the producer; in v1 `preste` is the canonical verifier) with a
 * pinned Ed25519 key selected by `keyid`. Everything the control plane gates on
 * MUST come from the SIGNED surface; specifically the deterministic-anchor
 * floor MUST be derived from `decisionCore.verdicts[].lensVerdicts[]` (which carry
 * per-lens `engine`/`criticality`/`fired` and ARE inside `outputHash`), NEVER from
 * a self-asserted top-level field. The set of REQUIRED anchors comes from the
 * server-side stage template, never from the envelope.
 *
 * INVARIANT the gate-runner MUST uphold: each deterministic anchor lens is named
 * exactly by its template AnchorId and wired with `criticality: "hard"`. Then a
 * hard anchor that fails fires and kills the candidate (acceptedIndex === null),
 * and a passing required anchor appears as a hard, non-llm-judge lensVerdict with
 * `fired === false`. {@link checkRequiredAnchors} verifies exactly that.
 *
 * This module is substrate-pure: it imports only agent-sdk primitives, never
 * product code, and never touches `proof/chain.ts` (governed-primitives invariant,
 * ADR-ECO-068). It reuses the battery's own `sha256` + `canonicalize` so a Citadel
 * recompute is byte-identical (zero drift).
 *
 * @module compute/battery/gate-envelope
 * @since delivery-control-plane v1 (feat/delivery-factory)
 */

import { sha256 } from "../../proof/sha256.js";
import { canonicalize } from "../../trace/canonical.js";
import type { SignFn, VerifyFn } from "../../remote/signing.js";
import type {
  BatteryDecision,
  CandidateVerdict,
  RejectedCandidate,
} from "./types.js";

/**
 * The decision kind the battery stamps into its decision core (battery.ts).
 * @public
 */
export const GATE_DECISION_KIND = "verifier-battery" as const;

/**
 * The battery decision core: the exact object the battery hashes into
 * `outputHash`. MUST match `battery.ts`'s `decisionCore` field-for-field so a
 * recompute matches. Fields are a subset of {@link BatteryDecision} plus `kind`.
 * @public
 */
export interface GateDecisionCore {
  readonly kind: typeof GATE_DECISION_KIND;
  readonly adrEco: string;
  readonly voteThreshold: number;
  readonly acceptedIndex: number | null;
  readonly acceptedHash: string | null;
  readonly acceptedScore: number | null;
  readonly verdicts: readonly CandidateVerdict[];
  readonly rejected: readonly RejectedCandidate[];
}

/**
 * A verifier-signed gate verdict. The signature covers every field except `sig`.
 * `decisionCore` + `outputHash` carry the tamper-evident verdict; `runId`,
 * `stageId`, `attempt`, `commit` bind it to a specific durable position; `keyid`
 * selects the verifier key; `producerId` records who produced the artifact
 * (producer ≠ verifier, operationally enforced in v1).
 * @public
 */
export interface GateVerdictEnvelope {
  readonly runId: string;
  readonly stageId: string;
  /** Monotonic attempt; bound against the task's delivery_attempt (anti-replay). */
  readonly attempt: number;
  /** Git commit on the delivery branch the gated artifact lives at. */
  readonly commit: string;
  /** Identity that produced the artifact (distinct from the signing verifier). */
  readonly producerId: string;
  /** Key id selecting the verifier public key in the control plane's registry. */
  readonly keyid: string;
  /** = decisionCore.acceptedHash. Convenience; the authoritative source is decisionCore. */
  readonly artifactHash: string;
  readonly decisionCore: GateDecisionCore;
  /** = sha256(canonicalize(decisionCore)); = BatteryDecision.auditStep.outputHash. */
  readonly outputHash: string;
  /**
   * OPTIONAL per-run frozen policy digest this verdict binds to. When present it
   * enters the signed surface (so a verdict is provably bound to the policy that
   * was frozen for the run). When ABSENT it is omitted from the canonical string
   * (JCS / RFC 8785 omits `undefined` object members), so envelopes that predate
   * this field and any new envelope built without it sign and verify
   * byte-identically to before. Back-compatible by construction.
   */
  readonly policy_digest?: string;
  /**
   * OPTIONAL event-chain head observed by the producer at gate time (item 13b).
   * 64 lowercase hex chars (sha-256 of the last hashed event in the run log).
   * When present it enters the signed surface, binding the verdict to the chain
   * history the producer saw. When ABSENT it is omitted from the canonical string
   * (JCS / RFC 8785 omits `undefined`), so pre-13b envelopes verify unchanged.
   * Back-compatible by construction.
   */
  readonly chain_head?: string;
  /** Ed25519 (hex) over canonicalize(envelope without `sig`). Absent until signed. */
  readonly sig?: string;
}

/**
 * Reconstruct the exact battery decision core from a battery decision (for hashing).
 * @public
 */
export function reconstructDecisionCore(d: BatteryDecision): GateDecisionCore {
  return {
    kind: GATE_DECISION_KIND,
    adrEco: d.adrEco,
    voteThreshold: d.voteThreshold,
    acceptedIndex: d.acceptedIndex,
    acceptedHash: d.acceptedHash,
    acceptedScore: d.acceptedScore,
    verdicts: d.verdicts,
    rejected: d.rejected,
  };
}

/**
 * Compute sha256(canonicalize(decisionCore)) using the same functions the battery uses.
 * @public
 */
export async function recomputeOutputHash(
  core: GateDecisionCore,
): Promise<string> {
  return sha256(canonicalize(core));
}

/**
 * Return the canonical, signature-excluded string form of an envelope (the signed bytes).
 * @public
 */
export function canonicalEnvelopeString(env: GateVerdictEnvelope): string {
  const { sig: _sig, ...rest } = env;
  return canonicalize(rest);
}

/**
 * Identity and position inputs the verifier stamps onto an envelope.
 * @public
 */
export interface BuildGateEnvelopeParams {
  readonly runId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly commit: string;
  readonly producerId: string;
  readonly keyid: string;
}

/**
 * Assemble an unsigned envelope from a battery decision. `artifactHash` and
 * `outputHash` are taken from the decision so they are guaranteed consistent with
 * what the battery actually produced.
 * @public
 */
export function buildGateEnvelope(
  p: BuildGateEnvelopeParams,
  decision: BatteryDecision,
): GateVerdictEnvelope {
  return {
    runId: p.runId,
    stageId: p.stageId,
    attempt: p.attempt,
    commit: p.commit,
    producerId: p.producerId,
    keyid: p.keyid,
    artifactHash: decision.acceptedHash ?? "",
    decisionCore: reconstructDecisionCore(decision),
    outputHash: decision.auditStep.outputHash,
  };
}

/**
 * Return a copy of the envelope with `sig` set to its Ed25519 signature.
 * @public
 */
export function signGateEnvelope(
  env: GateVerdictEnvelope,
  sign: SignFn,
): GateVerdictEnvelope {
  return { ...env, sig: sign(canonicalEnvelopeString(env)) };
}

/**
 * Result of a verification step: valid flag plus the reasons it failed (if any).
 * @public
 */
export interface EnvelopeVerification {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/**
 * Crypto + structural verification (pure): signature, outputHash recompute,
 * admission, and acceptedHash/artifactHash coherence. The caller (Citadel)
 * resolves `verify` from `env.keyid` via its key registry, and separately checks
 * `runId`/`stageId`/`attempt` against durable task state and the required-anchor
 * floor via {@link checkRequiredAnchors}.
 * @public
 */
export async function verifyGateEnvelope(
  env: GateVerdictEnvelope,
  verify: VerifyFn,
): Promise<EnvelopeVerification> {
  const reasons: string[] = [];

  if (typeof env.sig !== "string" || env.sig === "") {
    reasons.push("missing signature");
  } else {
    let ok = false;
    try {
      ok = verify(canonicalEnvelopeString(env), env.sig);
    } catch {
      ok = false;
    }
    if (!ok)
      reasons.push("signature does not verify against the pinned verifier key");
  }

  const recomputed = await recomputeOutputHash(env.decisionCore);
  if (recomputed !== env.outputHash) {
    reasons.push("outputHash mismatch (decisionCore tampered or wrong hash)");
  }

  const ai = env.decisionCore.acceptedIndex;
  if (ai === null) {
    reasons.push(
      "decisionCore is not admitted (acceptedIndex is null = all candidates killed)",
    );
  } else if (env.decisionCore.acceptedHash !== env.artifactHash) {
    reasons.push("acceptedHash does not equal artifactHash");
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Derive the deterministic-anchor floor from the SIGNED verdicts (B1/B2 fix).
 *
 * For the accepted candidate, every `requiredAnchorId` (supplied by the
 * server-side stage template, NOT the envelope) MUST appear as a lensVerdict that
 * is a deterministic (non-`llm-judge`), `hard` lens which did NOT fire (i.e. the
 * anchor passed). Acceptance alone is insufficient: a soft anchor can fail while
 * the lone candidate is still accepted, so the floor is checked explicitly here
 * against signed, in-`outputHash` data.
 *
 * Lens naming invariant: the gate-runner names each anchor lens exactly by its
 * template AnchorId, so `lensVerdict.lens === requiredAnchorId`.
 * @public
 */
export function checkRequiredAnchors(
  core: GateDecisionCore,
  requiredAnchorIds: readonly string[],
): EnvelopeVerification {
  if (core.acceptedIndex === null) {
    return {
      valid: false,
      reasons: ["no accepted candidate (acceptedIndex null)"],
    };
  }
  const accepted = core.verdicts[core.acceptedIndex];
  if (!accepted) {
    return {
      valid: false,
      reasons: ["accepted verdict missing from decisionCore.verdicts"],
    };
  }
  const byLens = new Map(accepted.lensVerdicts.map((lv) => [lv.lens, lv]));
  const reasons: string[] = [];
  for (const id of requiredAnchorIds) {
    const lv = byLens.get(id);
    if (!lv) {
      reasons.push(`required anchor "${id}" absent from signed verdict`);
      continue;
    }
    if (lv.engine === "llm-judge") {
      reasons.push(
        `required anchor "${id}" is an llm-judge, not a deterministic floor`,
      );
    }
    if (lv.criticality !== "hard") {
      reasons.push(
        `required anchor "${id}" is not hard criticality (cannot gate)`,
      );
    }
    if (lv.fired) {
      reasons.push(`required anchor "${id}" fired (the check failed)`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}
