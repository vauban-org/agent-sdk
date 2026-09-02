/**
 * delivery/ ; the delivery-factory gate module.
 *
 * WHAT THIS IS. The machinery that turns a stage artifact into a SIGNED
 * GateVerdictEnvelope whose `decisionCore.verdicts[]` carries a real, per-anchor
 * verdict. `compute/battery/gate-envelope.ts` defines the envelope and the
 * control-plane-side verification (`checkRequiredAnchors`); this module is the
 * producer side that fills it, so an envelope is an attestation of something
 * actually checked rather than an empty shell.
 *
 * THE MODULE FRONTIER. Everything here is pure or takes its I/O injected, with
 * ONE exception: `node-exec.ts`, the only file importing `node:child_process` /
 * `node:fs`. That split is deliberate ; a caller can drive the entire gate
 * (anchors, B3 commit binding, config validation, drift lens) against
 * deterministic mocks, and the real spawn-backed executors are opt-in.
 *
 * WHY IT LIVES IN THE SDK. `validateTestCommand` is a security allowlist over an
 * UNTRUSTED producer-declared command. Two copies of a security allowlist
 * diverge; there is exactly one, here, shared by every consumer that needs to
 * ground an anchor in a real test run.
 *
 * @module delivery
 */

export {
  ADVERSARY_ANGLES,
  type AdversaryConfigInput,
  type AdversaryIntensity,
  buildAdversaryLenses,
  type RefuteFn,
} from "./adversary.js";
export {
  ANCHOR_CHECKS,
  CONFIG_GROUNDED_ANCHORS,
  ENGINE_GROUNDED_ANCHORS,
  EXECUTION_GROUNDED_ANCHORS,
  POST_CHAR_LIMIT,
} from "./anchor-checks.js";
export { runConfigValidation } from "./config-validation.js";
export {
  buildDriftLens,
  DRIFT_ANCHOR_ID,
  type DriftArtifact,
  type FrozenIntent,
} from "./drift-lens.js";
export {
  buildAnchorLens,
  runDriftGate,
  type RunDriftGateInput,
  runGate,
  type RunGateAdversaryInput,
  type RunGateInput,
  type RunGateResult,
  runGateUnsigned,
  type RunGateUnsignedInput,
  type RunGateUnsignedResult,
  type UnsignedGateVerdictEnvelope,
} from "./gate-runner.js";
export { extractTestFailureDetail, runGroundedTests } from "./grounded-tests.js";
export {
  buildFileReader,
  buildGitExec,
  buildRealExec,
  type ParsedTestCommand,
  validateTestCommand,
} from "./node-exec.js";
export type {
  AnchorCheck,
  AnchorSpecInput,
  ConfigValidationResult,
  EngineVerdict,
  ExecFn,
  ExecResult,
  FileReader,
  GroundedTestResult,
} from "./types.js";
