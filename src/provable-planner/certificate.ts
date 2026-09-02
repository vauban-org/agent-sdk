/**
 * execution-planner production-readiness certificate (ADR-ECO-093).
 *
 * Promotes the research composite certificate (research-wm PoC-33, on a REAL Binance L2
 * book; PR #49) into the published SDK as a reusable, policy-agnostic primitive. It is the
 * MACHINERY only: the consumer computes the execution-specific layer verdicts (e.g. by
 * walking a real order book) and passes them in; this module deterministically aggregates
 * them into a `production_ready` verdict and grades the whole certificate A3 via the
 * existing provable-planner pipe ({@link decideProvably} / {@link verifyDecisionReexecution}).
 *
 * Three invariants carried over from PoC-30/PoC-33, all enforced here:
 *   1. HONESTY ; a planner carries only the layers its structure ADMITS. A non-admitted
 *      layer is recorded (`admitted:false`) and NEVER gates `production_ready`.
 *   2. FAIL-CLOSED gating ; `production_ready = (>=1 admitted layer) AND every admitted
 *      layer passed`. No admitted layer, or any admitted layer failing, => not ready.
 *   3. A3 ; the certificate is a deterministic function of its committed input (the layer
 *      verdicts), so it re-executes byte-identically (A3); tampering production_ready OR
 *      any nested layer field changes the leaf => A0.
 *
 * It is NOT a profitability / edge claim. `production_ready=true` certifies the planner's
 * STRUCTURAL guarantees on the committed data, never its alpha (ADR-ECO-093 scope).
 */

import {
  type DecisionClaim,
  type DecisionGrade,
  type GovernedDecision,
  type ReexecVerdict,
  decideProvably,
  gradeDecision,
  verifyDecisionReexecution,
} from "./index.js";

export const EXECUTION_CERT_POLICY_ID = "vauban.execution-planner-certificate";
export const EXECUTION_CERT_POLICY_VERSION = "vauban.execution-planner-certificate@v1";

/**
 * One certificate layer verdict, computed by the consumer. `detail` MUST be JSON-stable
 * (integer-quantized metrics, not raw floats) so the certificate leaf is byte-reproducible.
 */
export interface CertificateLayer {
  /** layer name, e.g. "decision_a3" | "adversarial" | "robustness" | "determinism" | "regret_bound". */
  readonly name: string;
  /** does the planner's structure admit (earn) this layer? */
  readonly admitted: boolean;
  /** the layer verdict; only gates when admitted. Convention: false for a non-admitted layer. */
  readonly passed: boolean;
  /** quantized, JSON-stable evidence for the verdict (no raw floats). */
  readonly detail: Record<string, unknown>;
}

/** The committed input to the certificate: the subject id + the consumer-computed layers. */
export interface CompositeCertificateInput {
  /** subject planner identifier (and, by convention, a dataset fingerprint the caller binds). */
  readonly subject: string;
  /** optional fingerprint of the dataset the layers were computed on (binds the cert to data). */
  readonly dataFingerprint?: string;
  readonly layers: readonly CertificateLayer[];
}

/** The deterministic certificate core (the committed output). */
export interface CompositeCertificateCore {
  readonly subject: string;
  readonly dataFingerprint: string | null;
  readonly admittedLayers: string[];
  readonly notAdmittedLayers: string[];
  readonly layers: CertificateLayer[];
  readonly productionReady: boolean;
}

/**
 * Pure aggregation: layer verdicts -> composite core. Deterministic, no I/O, no clock.
 * This is the policy re-executed for the A3 grade.
 */
export function certificateCore(input: CompositeCertificateInput): CompositeCertificateCore {
  // stable order by layer name so the leaf is canonical regardless of caller order
  const layers = [...input.layers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const admitted = layers.filter((l) => l.admitted);
  const admittedLayers = admitted.map((l) => l.name);
  const notAdmittedLayers = layers.filter((l) => !l.admitted).map((l) => l.name);
  // fail-closed: need at least one admitted layer, and every admitted layer must pass.
  const productionReady = admitted.length > 0 && admitted.every((l) => l.passed === true);
  return {
    subject: input.subject,
    dataFingerprint: input.dataFingerprint ?? null,
    admittedLayers,
    notAdmittedLayers,
    layers,
    productionReady,
  };
}

/**
 * Build a governed, A3-gradable execution-planner certificate from consumer-computed layer
 * verdicts. Enforces the four governed-primitive properties via {@link decideProvably}
 * (determinism, audit step, adrEco, replay). The returned claim is what gets committed /
 * anchored; an external verifier reaches A3 with {@link verifyExecutionCertificate}.
 */
export function executionPlannerCertificate(args: {
  input: CompositeCertificateInput;
  adrEco: string;
}): GovernedDecision<CompositeCertificateInput, CompositeCertificateCore> {
  return decideProvably({
    policyId: EXECUTION_CERT_POLICY_ID,
    policyVersion: EXECUTION_CERT_POLICY_VERSION,
    policy: certificateCore,
    input: args.input,
    adrEco: args.adrEco,
  });
}

/** Re-execute a committed certificate claim (external verifier path). */
export function verifyExecutionCertificate(
  claim: DecisionClaim<CompositeCertificateInput, CompositeCertificateCore>,
): ReexecVerdict<CompositeCertificateCore> {
  return verifyDecisionReexecution(claim, certificateCore, EXECUTION_CERT_POLICY_VERSION);
}

/** Grade a committed certificate. `externalVerifier` true only when verifier != producer. */
export function gradeExecutionCertificate(
  claim: DecisionClaim<CompositeCertificateInput, CompositeCertificateCore>,
  externalVerifier: boolean,
): DecisionGrade {
  return gradeDecision(verifyExecutionCertificate(claim), externalVerifier);
}
