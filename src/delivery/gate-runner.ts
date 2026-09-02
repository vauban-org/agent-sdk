/**
 * Delivery Factory: gate-runner (the verifier/producer side of the keystone).
 *
 * Runs a stage's deterministic anchor lenses (+ optional adversarial twin) over a
 * stage artifact via the VerifierBattery, then builds and signs a
 * GateVerdictEnvelope the Citadel control plane verifies in-transaction
 * (docs/architecture/delivery-control-plane.md §7).
 *
 * Producer ≠ verifier: this runs as the VERIFIER, distinct from whatever produced
 * the artifact. The anchor SPECS arrive as data from `get_current_stage` (MCP);
 * this module does NOT import the citadel template (no cross-repo coupling). Each
 * anchor lens is wired `hard` and named exactly by its AnchorId, so Citadel's
 * `checkRequiredAnchors` finds it in the signed verdicts (the deterministic
 * floor, B1/B2).
 *
 * @module delivery/gate-runner
 */

import { runVerifierBattery } from "../compute/battery/battery.js";
import {
  type GateVerdictEnvelope,
  buildGateEnvelope,
  signGateEnvelope,
} from "../compute/battery/gate-envelope.js";
import type { BatteryLens } from "../compute/battery/types.js";
import type { Verifier } from "../compute/verifier.js";
import type { SignFn } from "../remote/signing.js";
import { RealClock } from "../replay/clock.js";
import { type AdversaryConfigInput, type RefuteFn, buildAdversaryLenses } from "./adversary.js";
import {
  ANCHOR_CHECKS,
  CONFIG_GROUNDED_ANCHORS,
  ENGINE_GROUNDED_ANCHORS,
  EXECUTION_GROUNDED_ANCHORS,
  REQUIRE_POSITIVE_PASS,
} from "./anchor-checks.js";
import { runConfigValidation } from "./config-validation.js";
import { type DriftArtifact, type FrozenIntent, buildDriftLens } from "./drift-lens.js";
import { runGroundedTests } from "./grounded-tests.js";
import type {
  AnchorSpecInput,
  ConfigValidationResult,
  EngineVerdict,
  ExecFn,
  FileReader,
  GroundedTestResult,
} from "./types.js";

/**
 * Build a HARD anchor lens whose verifier name === the AnchorId (floor binding).
 *
 * Four lens flavors, dispatched by membership:
 *   - CONFIG_GROUNDED_ANCHORS (config-valid): read the REAL config-file content
 *     from the worktree via `configResult` (computed once by runGate). No reader
 *     wired / no worktree / unparseable artifact => fail closed.
 *   - EXECUTION_GROUNDED_ANCHORS (ci-green / ci-e2e-green / pass-count): read the
 *     REAL test outcome from `grounded` (a single test run executed by runGate).
 *     Do NOT use the artifact's self-reported `ci_passed`. No run => fail closed.
 *   - ENGINE_GROUNDED_ANCHORS (test-surface-frozen / pass-count-monotone): read
 *     the verdict the CALLER measured, from `engineVerdicts` ; these are facts
 *     about the run's base commit and the run's own history, which neither the
 *     artifact bytes nor the test output carry. No injected verdict => fail
 *     closed (never an "artifact says it passed" fallback).
 *   - everything else: the pure ANCHOR_CHECKS function over the artifact bytes.
 */
export function buildAnchorLens(
  spec: AnchorSpecInput,
  grounded?: GroundedTestResult,
  configResult?: ConfigValidationResult,
  engineVerdicts?: ReadonlyMap<string, EngineVerdict>,
): BatteryLens<string> {
  const isConfigGrounded = CONFIG_GROUNDED_ANCHORS.has(spec.id);
  const isGrounded = EXECUTION_GROUNDED_ANCHORS.has(spec.id);
  const isEngineGrounded = ENGINE_GROUNDED_ANCHORS.has(spec.id);
  const check = ANCHOR_CHECKS[spec.id];
  const verifier: Verifier<string> = {
    name: spec.id,
    evaluate: (artifact) => {
      if (isEngineGrounded) {
        const e = engineVerdicts?.get(spec.id);
        if (!e) {
          return {
            score: 0,
            rationale: `${spec.id}: no engine-measured verdict supplied (fail-closed)`,
          };
        }
        return { score: e.pass ? 1 : 0, rationale: e.rationale };
      }
      if (isConfigGrounded) {
        const c = configResult;
        if (!c || !c.ran) {
          return {
            score: 0,
            rationale: `${spec.id}: ${c?.rationale ?? "no config validation result (fail-closed)"}`,
          };
        }
        return { score: c.valid ? 1 : 0, rationale: c.rationale };
      }
      if (isGrounded) {
        const g = grounded;
        if (!g || !g.ran) {
          return {
            score: 0,
            rationale: `${spec.id}: ${g?.rationale ?? "no grounded test result (fail-closed)"}`,
          };
        }
        // pass-count[-positive] additionally requires >=1 passing test detected.
        const pass =
          g.exitCode === 0 &&
          g.failCount === 0 &&
          (REQUIRE_POSITIVE_PASS.has(spec.id) ? g.passCount > 0 : true);
        return { score: pass ? 1 : 0, rationale: g.rationale };
      }
      if (!check)
        return {
          score: 0,
          rationale: `unknown anchor "${spec.id}" (fail-closed)`,
        };
      const r = check(artifact);
      return { score: r.pass ? 1 : 0, rationale: r.rationale };
    },
  };
  return {
    verifier,
    polarity: "affirm",
    criticality: "hard",
    signature: { engine: spec.kind === "ci" ? "execution" : "rule" },
  };
}

/** Structured adversary configuration wired into `runGate`. */
export interface RunGateAdversaryInput {
  /** Which adversary intensity to apply (none / judge / refute-quorum). */
  readonly config: AdversaryConfigInput;
  /**
   * Injected LLM refuter. The driver supplies the real model call; tests supply
   * a mock. Must be provided when `config.intensity !== "none"`.
   */
  readonly refute: RefuteFn;
}

/**
 * Everything `runGate` needs EXCEPT the verifier identity (`keyid`) and its
 * private key (`sign`).
 *
 * It is its own input type because not every producer of a gate decision holds
 * the signing key: the usine v2 control-plane engine builds the decision inside a
 * durable step while the Citadel adapter is the sole holder of the Ed25519 key
 * that `keyid` names (`UnsignedStageEnvelope` omits both fields for exactly that
 * reason). Both callers go through {@link runGateUnsigned}, so there is ONE
 * implementation of the anchor floor, the B3 binding, and the battery.
 */
export interface RunGateUnsignedInput {
  readonly stageId: string;
  readonly artifact: string;
  readonly anchors: readonly AnchorSpecInput[];
  readonly runId: string;
  readonly adrEco: string;
  readonly attempt: number;
  readonly commit: string;
  readonly producerId: string;
  /**
   * Optional raw adversarial-twin lenses (soft refuters). Kept for
   * backward-compatibility; use `adversary` for the structured API.
   */
  readonly twinLenses?: readonly BatteryLens<string>[];
  /**
   * Structured adversary configuration. When provided, `buildAdversaryLenses`
   * is called with `input.artifact` and the lenses are appended to the battery
   * alongside any `twinLenses`. The hard anchor floor is unaffected.
   */
  readonly adversary?: RunGateAdversaryInput;
  /**
   * Real command executor. When a stage carries an execution-grounded anchor
   * (ci-green / ci-e2e-green / pass-count), runGate runs the artifact's declared
   * `test_cmd` in its `worktree` ONCE via this executor and binds the REAL exit
   * code into those lenses. Without it, those anchors fail closed (no
   * self-attestation path). Pure stages ignore it.
   */
  readonly exec?: ExecFn;
  /**
   * Git-capable executor for the B3 commit-binding check (`git rev-parse HEAD`).
   * Distinct from `exec` (the test-runner allowlist executor) because git is not
   * a permitted test-runner. When absent, the B3 check falls back to `exec`
   * (which rejects git, failing B3 closed) — supply buildGitExec() in production.
   */
  readonly gitExec?: ExecFn;
  /**
   * File reader for the content-grounded `config-valid` anchor. When a stage
   * carries config-valid, runGate reads each declared config file from the
   * artifact's `worktree` ONCE via this reader and parses/validates it. Without
   * it, config-valid fails closed (no reader, no seal — same posture as ci-green
   * with no executor). Supply buildFileReader() in production; tests inject a
   * mock. Stages without config-valid ignore it.
   */
  readonly readFile?: FileReader;
  /**
   * Per-run frozen policy digest (64 lowercase hex chars). When present the
   * signed envelope carries `policy_digest` top-level (wave A field). JCS omits
   * `undefined` members, so envelopes built without this field sign and verify
   * byte-identically to before (back-compatible by construction).
   */
  readonly policyDigest?: string;
  /**
   * Event-chain head observed by the producer (64 lowercase hex chars). When
   * present the signed envelope carries `chain_head` top-level (additif). JCS
   * omits `undefined` members, so absent = byte-identical to pre-change
   * signatures (back-compatible by construction). Pattern: item 13b, identical
   * seam to policy_digest (item 11).
   */
  readonly chainHead?: string;
  /**
   * Verdicts the CALLER measured for the {@link
   * ./anchor-checks.ENGINE_GROUNDED_ANCHORS} it carries, keyed by AnchorId. A
   * required anchor in that set with no entry here fails closed. Ignored by
   * stages that carry none.
   */
  readonly engineVerdicts?: ReadonlyMap<string, EngineVerdict>;
  /**
   * A test result the caller ALREADY measured. When supplied, the gate uses it
   * verbatim and does NOT run the test command itself (`exec`/`gitExec` are then
   * unused by the execution-grounded lenses).
   *
   * This is not an optimisation. The usine v2 engine runs the suite inside its
   * durable `verify` step and builds the envelope in a LATER step; re-running the
   * suite while signing would (a) execute the tests twice per attempt, and (b)
   * break the durable-replay property, since a crash-recovered run replays the
   * journaled measurement while a re-run could legitimately return a different
   * answer (a flaky suite). Passing the journaled measurement keeps the signed
   * verdict bound to the execution that actually happened.
   *
   * It is NOT a self-attestation path: the value must be a real
   * {@link GroundedTestResult} produced by whoever RAN the command (`ran:false`
   * still fails every execution-grounded anchor closed). What is forbidden, and
   * still impossible here, is reading a producer's `ci_passed:true` out of the
   * artifact bytes.
   */
  readonly grounded?: GroundedTestResult;
}

export interface RunGateInput extends RunGateUnsignedInput {
  /** Key id selecting the verifier public key in the control plane's registry. */
  readonly keyid: string;
  readonly sign: SignFn;
}

/** A gate envelope before the key holder stamps its `keyid` and signature. */
export type UnsignedGateVerdictEnvelope = Omit<GateVerdictEnvelope, "sig" | "keyid">;

export interface RunGateResult {
  readonly accepted: boolean;
  readonly envelope: GateVerdictEnvelope;
  readonly reasons: readonly string[];
}

export interface RunGateUnsignedResult {
  readonly accepted: boolean;
  readonly envelope: UnsignedGateVerdictEnvelope;
  readonly reasons: readonly string[];
}

/**
 * Run the stage gate over an artifact and produce the UNSIGNED envelope: the
 * artifact is the single candidate, the anchor lenses are the hard floor, and
 * optional `twinLenses` / `adversary` add adversarial signal on top. Returns the
 * envelope regardless of accept (a denied gate yields a non-admitted envelope the
 * control plane will reject).
 *
 * This is the whole gate MINUS the signature, for a producer that does not hold
 * the verifier key (the usine v2 engine ; its Citadel adapter signs). {@link
 * runGate} is this function plus `keyid` + `signGateEnvelope`, so the floor, the
 * B3 binding, and the battery have exactly one implementation.
 *
 * Adversary wiring:
 *   - `twinLenses`  ; backward-compat raw lenses passed through as-is.
 *   - `adversary`   ; structured config; `buildAdversaryLenses` is called with
 *                     the artifact and the refuter; the resulting soft refute
 *                     lenses are appended to the battery. The hard anchor floor
 *                     satisfies the non-llm-judge governance invariant so the
 *                     battery governance check passes even with llm-judge lenses.
 */
export async function runGateUnsigned(input: RunGateUnsignedInput): Promise<RunGateUnsignedResult> {
  // If any required anchor is execution-grounded, run the real test command ONCE
  // and share the result across those lenses. Computed even when exec is absent
  // so the lenses fail closed with a clear rationale.
  const needsGrounding = input.anchors.some((a) => EXECUTION_GROUNDED_ANCHORS.has(a.id));
  // B3: pass the envelope commit so runGroundedTests can verify the worktree
  // HEAD matches before running any test command. A caller that already ran the
  // suite supplies `grounded` and the command is NOT run a second time (see that
  // field's doc for why re-running would be wrong, not merely wasteful).
  const grounded =
    input.grounded ??
    (needsGrounding
      ? runGroundedTests(input.artifact, input.exec, input.commit, input.gitExec)
      : undefined);
  // If any required anchor is content-grounded (config-valid), read + validate
  // the declared config files ONCE and share the result across those lenses.
  // Computed even when readFile is absent so the lens fails closed with a clear
  // rationale (no reader == no seal).
  const needsConfig = input.anchors.some((a) => CONFIG_GROUNDED_ANCHORS.has(a.id));
  const configResult = needsConfig
    ? runConfigValidation(input.artifact, input.readFile)
    : undefined;
  const floor = input.anchors.map((a) =>
    buildAnchorLens(a, grounded, configResult, input.engineVerdicts),
  );
  const adversaryLenses: BatteryLens<string>[] = input.adversary
    ? buildAdversaryLenses({
        stageId: input.stageId,
        artifact: input.artifact,
        config: input.adversary.config,
        refute: input.adversary.refute,
      })
    : [];
  const lenses: BatteryLens<string>[] = [...floor, ...(input.twinLenses ?? []), ...adversaryLenses];
  const decision = await runVerifierBattery<string>(input.artifact, [input.artifact], lenses, {
    clock: new RealClock(),
    runId: input.runId,
    adrEco: input.adrEco,
  });
  // `buildGateEnvelope` takes a keyid; the unsigned form omits it. Building with
  // a placeholder and dropping it keeps ONE envelope constructor for both paths,
  // and JCS sorts keys, so the caller re-adding `keyid` yields byte-identical
  // signed bytes to the single-shot `runGate` path.
  const { keyid: _placeholder, ...baseEnvelope } = buildGateEnvelope(
    {
      runId: input.runId,
      stageId: input.stageId,
      attempt: input.attempt,
      commit: input.commit,
      producerId: input.producerId,
      keyid: "",
    },
    decision,
  );
  // Attach policy_digest when present. JCS (canonicalize) omits `undefined`
  // members, so the signed bytes are byte-identical when the field is absent.
  const envelopeWithDigest =
    input.policyDigest !== undefined
      ? { ...baseEnvelope, policy_digest: input.policyDigest }
      : baseEnvelope;
  // Attach chain_head when present (item 13b). Same byte-compat pattern.
  const envelope =
    input.chainHead !== undefined
      ? { ...envelopeWithDigest, chain_head: input.chainHead }
      : envelopeWithDigest;
  const reasons = decision.rejected.map((r) => r.reason);
  return { accepted: decision.acceptedIndex !== null, envelope, reasons };
}

/**
 * Run the stage gate over an artifact and produce a SIGNED envelope. {@link
 * runGateUnsigned} plus the verifier identity: `keyid` is stamped and the
 * canonical, signature-excluded bytes are signed.
 */
export async function runGate(input: RunGateInput): Promise<RunGateResult> {
  const { keyid, sign, ...unsigned } = input;
  const result = await runGateUnsigned(unsigned);
  return {
    accepted: result.accepted,
    envelope: signGateEnvelope({ ...result.envelope, keyid }, sign),
    reasons: result.reasons,
  };
}

// ─── Drift gate (second independent attestation) ──────────────────────────────

/**
 * Inputs for the second independent attestation (drift signer).
 *
 * The envelope produced here carries the SAME runId/stageId/attempt/commit and
 * the SAME artifactHash as the primary envelope. The keyid MUST be distinct
 * (enforced by the Citadel guard). The decisionCore contains the anti-drift-scope
 * lens verdict, which the guard checks as the required anchor.
 *
 * Doctrine: this is the SECOND INDEPENDENT ATTESTATION; it is not an aggregate
 * of the primary envelope. Two Ed25519 signatures from distinct keys on the same
 * artifact, each independently verifiable. Never use the word "aggregate" for
 * this mechanism.
 */
export interface RunDriftGateInput {
  /** Primary envelope produced by runGate: provides the shared identity fields. */
  readonly primaryEnvelope: GateVerdictEnvelope;
  /**
   * The original artifact content (same string passed to runGate). The battery
   * hashes this to produce artifactHash, which must match the primary envelope's
   * artifactHash (anti-splice invariant).
   */
  readonly artifact: string;
  /** Frozen intention (must carry scope.allowed_paths). */
  readonly intent: FrozenIntent | null | undefined;
  /** Drift artifact (must carry worktree, diff_base, diff_head). */
  readonly driftArtifact: DriftArtifact | null | undefined;
  /** Keyid for the drift signer. MUST differ from primaryEnvelope.keyid. */
  readonly keyid: string;
  /** ADR-ECO governing this gate (same as the primary gate). */
  readonly adrEco: string;
  /** Signing function for the drift key. */
  readonly sign: SignFn;
  /** Command executor for git diff. */
  readonly exec: ExecFn | undefined;
}

/**
 * Produce the second independent attestation envelope for a dual-twin stage.
 *
 * Reuses buildGateEnvelope + signGateEnvelope + runVerifierBattery unchanged.
 * The drift lens (anti-drift-scope, hard, execution, affirm, never llm-judge)
 * is the sole lens in the battery. The envelope shares the primary envelope's
 * runId/stageId/attempt/commit and artifactHash (anti-splice identity check).
 */
export async function runDriftGate(input: RunDriftGateInput): Promise<RunGateResult> {
  // Pass the primary envelope commit as expectedHead (DETTES-1 fix, spec 1.3).
  // runDriftGate shares the primary envelope commit so the drift attestation
  // is bound to the exact commit that was gated; fail-closed if non-hex.
  const driftLens = buildDriftLens(
    input.intent,
    input.driftArtifact,
    input.exec,
    input.primaryEnvelope.commit,
  );

  // Pass the original artifact so the battery produces the same artifactHash
  // as the primary envelope (anti-splice: both attest the SAME artifact).
  const decision = await runVerifierBattery<string>(input.artifact, [input.artifact], [driftLens], {
    clock: new RealClock(),
    runId: input.primaryEnvelope.runId,
    adrEco: input.adrEco,
  });

  const baseDriftEnvelope = buildGateEnvelope(
    {
      runId: input.primaryEnvelope.runId,
      stageId: input.primaryEnvelope.stageId,
      attempt: input.primaryEnvelope.attempt,
      commit: input.primaryEnvelope.commit,
      producerId: input.primaryEnvelope.producerId,
      keyid: input.keyid,
    },
    decision,
  );
  // Copy policy_digest from the primary envelope (same contract: same run =>
  // same frozen policy). JCS omits `undefined`, so byte-compat when absent.
  const driftWithDigest =
    input.primaryEnvelope.policy_digest !== undefined
      ? {
          ...baseDriftEnvelope,
          policy_digest: input.primaryEnvelope.policy_digest,
        }
      : baseDriftEnvelope;
  // Copy chain_head from the primary envelope (item 13b). Identity 4b: drift
  // carries the same chain_head as the primary when present. Byte-compat when
  // absent (JCS omits undefined).
  const driftEnvelopeToSign =
    input.primaryEnvelope.chain_head !== undefined
      ? { ...driftWithDigest, chain_head: input.primaryEnvelope.chain_head }
      : driftWithDigest;
  const envelope = signGateEnvelope(driftEnvelopeToSign, input.sign);

  const reasons = decision.rejected.map((r) => r.reason);
  return { accepted: decision.acceptedIndex !== null, envelope, reasons };
}
