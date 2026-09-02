/**
 * provable-planner ; the reusable provable WM-planner primitive (ADR-ECO-092).
 *
 * Promotes the research spine `research-wm/packages/provable-core` (L1, PR #49 ; 31 PoCs,
 * 462 tests) into the published SDK so any Vauban agent can produce a re-executable,
 * A3-gradable decision without reimplementing the four governed-primitive properties or
 * coupling the command-center monolith.
 *
 * Single source of truth for the leaf: the JCS + SHA-256 implementation is REUSED from
 * `../proof/index.js` (`canonicalize`, `leafHash`) ; there is no second `normalize` here.
 * That same `canonicalize` is byte-identical to the host `src/proof/decision-reexec-proof.ts`
 * `jcs` and to the research mirror, asserted by the parity test (tests/provable-planner/).
 *
 * The honest claim a provable WM-planner makes: "this decision is the correct output of
 * policy `policyId@policyVersion` on the committed input." It is a PROCESS / accountability
 * proof (re-executable), never an alpha or optimality claim.
 *
 * Grade ladder:
 *   external party re-executes OK (producer != verifier) -> A3
 *   producer self-attests                                 -> A1
 *   mismatch / wrong policy version                       -> A0 (reject)
 *
 * Four governed-primitive properties (ADR-ECO-068):
 *   1. determinism ; policy run twice, JCS-compared
 *   2. one timestamped audit step ; outputHash = sha256(JCS(decisionCore))
 *   3. ADR-traceability ; non-empty adrEco mandatory or GovernanceError
 *   4. replay ; byte-identical reconstruction asserted by {@link assertReplay}
 */

import { canonicalize, leafHash } from "../proof/index.js";

export { type GateDecisionCore, provableActionGate } from "./action-gate.js";
export {
  type CertificateLayer,
  certificateCore,
  type CompositeCertificateCore,
  type CompositeCertificateInput,
  EXECUTION_CERT_POLICY_ID,
  EXECUTION_CERT_POLICY_VERSION,
  executionPlannerCertificate,
  gradeExecutionCertificate,
  verifyExecutionCertificate,
} from "./certificate.js";

/** JCS over any JSON value, delegated to the single SDK canonicaliser (../proof). */
function jcs(value: unknown): string {
  // canonicalize's runtime normalize handles any JSON value; the object type is a TS hint.
  return canonicalize(value as Record<string, unknown>);
}

/** A pure, deterministic decision policy: same input gives same output, no I/O, no clock. */
export type DeterministicPolicy<I, O> = (input: I) => O;

/** The committed decision claim. `output` MUST be the deterministic DECISION CORE only. */
export interface DecisionClaim<I, O> {
  policyId: string;
  policyVersion: string;
  input: I;
  output: O;
}

/** Assurance grade reachable by re-execution. A2 (anchor-confirmation) is set elsewhere. */
export type DecisionGrade = "A0" | "A1" | "A3";

export interface ReexecVerdict<O> {
  ok: boolean;
  recomputed?: O;
  reason?: "policy-version-mismatch" | "output-mismatch";
}

/** Raised when a governed primitive is constructed without ADR traceability. */
export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

/**
 * Canonical anchor-leaf preimage for an `agent_decision_proof` row. Field NAMES are
 * load-bearing and match the host canonicaliser exactly.
 */
export function decisionAnchorPreimage(p: {
  id: string;
  agentId: string;
  policyId: string;
  policyVersion: string;
  input: unknown;
  output: unknown;
  decidedAt: string;
}): Record<string, unknown> {
  return {
    id: p.id,
    agent_id: p.agentId,
    policy_id: p.policyId,
    policy_version: p.policyVersion,
    input: p.input,
    output: p.output,
    decided_at: p.decidedAt,
  };
}

/**
 * Independently re-execute the policy on the committed input and check the output.
 * Comparison is JCS-stable (key order independent). Byte-identical contract to the host
 * `verifyDecisionReexecution`.
 */
export function verifyDecisionReexecution<I, O>(
  claim: DecisionClaim<I, O>,
  policy: DeterministicPolicy<I, O>,
  expectedPolicyVersion: string,
): ReexecVerdict<O> {
  if (claim.policyVersion !== expectedPolicyVersion) {
    return { ok: false, reason: "policy-version-mismatch" };
  }
  const recomputed = policy(claim.input);
  const ok = jcs(recomputed) === jcs(claim.output);
  return ok ? { ok, recomputed } : { ok, recomputed, reason: "output-mismatch" };
}

/**
 * Grade a decision from its re-execution verdict. `externalVerifier` MUST be true only
 * when the verifier is a party distinct from the producer.
 */
export function gradeDecision(
  verdict: ReexecVerdict<unknown>,
  externalVerifier: boolean,
): DecisionGrade {
  if (!verdict.ok) return "A0";
  return externalVerifier ? "A3" : "A1";
}

// ─── Governed-primitive layer (ADR-ECO-068 four properties) ──────────────────────

/** The single timestamped audit step a governed primitive emits (phase guard). */
export interface AuditStep {
  readonly phase: "guard";
  readonly type: "guard_check";
  readonly policy: "hash-only";
  /** sha256(JCS(decisionCore)). */
  readonly outputHash: string;
  /** ADR this decision binds to (mandatory; property 3). */
  readonly adrEco: string;
}

/** Build the one audit step for a decision core ; property 2. */
export function emitAuditStep(decisionCore: unknown, adrEco: string): AuditStep {
  if (!adrEco || adrEco.trim() === "") {
    throw new GovernanceError(
      "governed primitive requires a non-empty adrEco (ADR-traceability, property 3)",
    );
  }
  return {
    phase: "guard",
    type: "guard_check",
    policy: "hash-only",
    outputHash: leafHash(decisionCore as Record<string, unknown>),
    adrEco,
  };
}

/**
 * Property 4 (replay): assert the policy reconstructs byte-identical output for the
 * committed input. Returns the recomputed core or throws on drift.
 */
export function assertReplay<I, O>(
  claim: DecisionClaim<I, O>,
  policy: DeterministicPolicy<I, O>,
): O {
  const a = policy(claim.input);
  const b = policy(claim.input);
  if (jcs(a) !== jcs(b)) {
    throw new GovernanceError("policy is non-deterministic (property 1 violated)");
  }
  if (jcs(a) !== jcs(claim.output)) {
    throw new GovernanceError("replay drift: recomputed != committed output (property 4)");
  }
  return a;
}

/** A committed, governed decision: the claim + its single audit step. */
export interface GovernedDecision<I, O> {
  readonly claim: DecisionClaim<I, O>;
  readonly auditStep: AuditStep;
}

/**
 * Construct a governed, provable decision in one call. Enforces all four
 * governed-primitive properties:
 *   1. determinism ; policy run twice, JCS-compared
 *   2. audit step  ; one guard_check with outputHash
 *   3. adrEco      ; GovernanceError if absent
 *   4. replay      ; the audit hash is over the verified-stable core
 *
 * The returned `claim` is what gets committed (host INSERT into agent_decision_proof); an
 * external verifier later calls {@link verifyDecisionReexecution} + {@link gradeDecision}
 * to reach A3.
 */
export function decideProvably<I, O>(args: {
  policyId: string;
  policyVersion: string;
  policy: DeterministicPolicy<I, O>;
  input: I;
  adrEco: string;
}): GovernedDecision<I, O> {
  if (!args.adrEco || args.adrEco.trim() === "") {
    throw new GovernanceError(
      "decideProvably requires a non-empty adrEco (ADR-traceability, property 3)",
    );
  }
  const first = args.policy(args.input);
  const second = args.policy(args.input);
  if (jcs(first) !== jcs(second)) {
    throw new GovernanceError("policy is non-deterministic (property 1 violated)");
  }
  const claim: DecisionClaim<I, O> = {
    policyId: args.policyId,
    policyVersion: args.policyVersion,
    input: args.input,
    output: first,
  };
  const auditStep = emitAuditStep(first, args.adrEco);
  return { claim, auditStep };
}
