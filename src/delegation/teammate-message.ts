/**
 * delegation/teammate-message.ts
 *
 * Governed inter-agent messaging envelope for in-process teammate agents.
 * (packages/cli/docs/teammates-plan.md, SHAPE v2 post-adversarial ; TM1 of the
 * TM0 -> TM1 -> TM2 -> TM3 slice.)
 *
 * WHY THIS EXISTS. Claude Code Agent Teams (Feb 2026) gives addressable
 * mailboxes between agents; nothing in the surveyed landscape (Claude Code,
 * Google A2A, LangGraph Command/Send, AutoGen GroupChat, CrewAI) signs, scopes,
 * spotlights, or audit-chains a message. This module is the pure, in-process
 * core: it builds a signed envelope and fail-closed-verifies an "ask" claim
 * against the SENDER's own delegated capability scope (delegation/delegate.ts,
 * ADR-ECO-076). Delivery, spotlighting (`<external_data>` wrap), rate-limiting,
 * and the runId-addressed mailbox are OUT of this module (TM2,
 * packages/cli/src/teammate-mailbox.ts); this module never touches the CLI or
 * mesh/delegate.ts (a second, unrelated delegation lineage; adversarial #7).
 *
 * HONEST GUARANTEES (stated plainly, per the plan's adversarial review):
 *   - Signature = INSTALL-LEVEL PROVENANCE ONLY (adversarial #1). The signer
 *     port is per-install today (children spawned by the same install share
 *     one key); it proves the install produced the bytes, NOT which agent.
 *     Per-agent keys are the NHI Phase 1+ promotion path (nhi-agentic-iam.md).
 *   - The lens here constrains the SENDER's "ask" claims fail-closed AT SEND
 *     TIME (adversarial #5): a claim whose capability exceeds the sender's own
 *     attenuated scope is rejected before it ever reaches the mailbox. This is
 *     NOT an execution gate on the receiver; the receiver keeps its OWN
 *     ActionGate (delegate.ts) as the sole execution enforcement.
 *
 * THIN LAYER (adversarial #7): this module does not re-implement attenuation
 * or audit-step construction. It reuses `baseToolName()` (the SAME flat
 * tool-name normalization delegate.ts uses for `attenuatedTools`, see
 * delegate.ts:197) and `runVerifierBattery()` (the SAME audit-step
 * construction utility `delegate()` calls) with one new domain-specific lens
 * (`messageClaimScopeLens`), so a message-claim audit step is shape-identical
 * to a delegation-grant audit step and folds into the SAME per-run
 * TraceAccumulator (packages/cli/src/spawn-child-agent.ts, TM0) with no
 * adapter needed.
 *
 * No toName, no broadcast (adversarial #8): the envelope addresses exactly one
 * `toRunId`; runId is the only agent handle in this in-process model.
 *
 * @module delegation/teammate-message
 * @since ADR-ECO-076
 */

import { runVerifierBattery } from "../compute/battery/battery.js";
import type { BatteryLens, BatteryTraceStep } from "../compute/battery/types.js";
import { type SessionOriginKind, isSessionOriginKind } from "../remote/session-origin.js";
import type { SignFn, VerifyFn } from "../remote/signing.js";
import { type SubTokenScope, scopeCovers } from "../remote/sub-token.js";
import type { ClockPort } from "../replay/clock.js";
import { canonicalize } from "../trace/canonical.js";
import { DELEGATION_ADR, baseToolName } from "./delegate.js";

// ─── Envelope shape ───────────────────────────────────────────────────────────

/**
 * Maximum encoded body size, in UTF-8 bytes. Exported so the mailbox layer
 * (TM2) enforces the SAME bound at delivery time rather than a re-guessed
 * constant.
 * @public
 */
export const MAX_TEAMMATE_BODY_BYTES = 16 * 1024;

/**
 * A message claim. Four kinds:
 *   - `inform` carries no request ; the receiver just observes the body.
 *   - `ask` requests the receiver exercise `capability`. `capability` uses the
 *     SAME flat tool-name vocabulary as `DelegationPlan.attenuatedTools`
 *     (delegate.ts:197), normalized through the SAME `baseToolName()`, so scope
 *     containment is well-defined (adversarial #5).
 *   - `list_targets` (Z-C c1, adversarial #6) is a control-plane query asking
 *     the receiver for its opt-in, paired-peer-only addressable targets
 *     (session name -> runId). It carries NO capability and requests NO
 *     capability exercise, so it is HITL-EXEMPT BY CONSTRUCTION (see
 *     {@link isHitlGatableClaimKind}). It is a wire-forward-compatible ADDITION
 *     to the claim vocabulary : the envelope STRUCTURE is unchanged, so
 *     `schemaVersion` stays at {@link TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2}
 *     (which versions the envelope shape, not the claim enum).
 *   - `control` (SP1 ; see {@link CONTROLLER_CONTROL_ADR}) carries a
 *     {@link ControlVerb} in `capability`, exercised by a control-granted,
 *     boundary-authenticated HUMAN peer against a running session. Checked
 *     RECEIVER-side (contrast `ask`, checked SENDER-side ; see "Control claim"
 *     below). Same wire-forward-compatible addition : envelope structure
 *     unchanged, `schemaVersion` unaffected.
 * @public
 */
export interface TeammateMessageClaim {
  readonly kind: "inform" | "ask" | "list_targets" | "control";
  /**
   * For an `ask`, the requested tool capability. For a `control` claim, the
   * {@link ControlVerb} being exercised (rides the SAME field, no shape change,
   * so `schemaVersion` stays at {@link TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2}).
   */
  readonly capability?: string;
}

/**
 * Every claim kind THIS version recognizes. A receiver MUST fail closed on a
 * claim kind absent from this set (an envelope from a NEWER peer carrying a
 * kind this version predates) rather than route it as a benign `inform` : an
 * unknown kind could be a future GATED request this version does not know to
 * gate, so routing it unrecognized would be a silent mis-gate. The
 * teammate-mailbox receive pipeline drops an unrecognized kind fail-closed
 * (a `denied_unknown_kind` ledger entry) BEFORE routing. @public
 */
export const RECOGNIZED_CLAIM_KINDS: ReadonlySet<TeammateMessageClaim["kind"]> = new Set([
  "inform",
  "ask",
  "list_targets",
  "control",
]);

/** True iff `kind` is a claim kind this version recognizes. Narrowing guard
 * used by the sender-side envelope validation and the receiver-side
 * fail-closed drop. @public */
export function isRecognizedClaimKind(kind: string): kind is TeammateMessageClaim["kind"] {
  return RECOGNIZED_CLAIM_KINDS.has(kind as TeammateMessageClaim["kind"]);
}

/**
 * The HITL tier-gate applies to EXACTLY ONE claim kind : `ask`. `inform` and
 * `list_targets` are HITL-EXEMPT BY CONSTRUCTION (adversarial #6) : they are
 * control-plane plumbing that never requests the receiver exercise a
 * capability, so they carry no capability to gate and MUST NOT enter the
 * receiver's approval chain (`hitlChain`). This predicate is the SINGLE,
 * shared, structural source of that exemption : the mailbox's gate
 * classification (`teammate-mailbox.ts`'s `classifyGatedAsk`) consults it
 * instead of an inline `kind === "ask"` test, so the exemption is a named
 * property of the claim vocabulary, NOT a bypass branch forked into the
 * delivery pipeline (the plan's ZD3 : "structural in the classification, do not
 * fork the pipeline"). A `list_targets` cannot smuggle a gated capability : it
 * never reaches the receiver's ActionGate (the sole execution enforcement), it
 * only ever returns the receiver's opt-in, paired-peer-only target list.
 * @public
 */
export function isHitlGatableClaimKind(kind: TeammateMessageClaim["kind"]): boolean {
  return kind === "ask";
}

/**
 * The signed, wire-stable v1 envelope. No `toName`, no broadcast field; runId
 * is the only agent handle in v1 (adversarial #8). FROZEN: the exact field
 * set below is what `canonicalTeammateEnvelopeString` signs/verifies over for
 * a v1 envelope (sprint-878's verify-by-version invariant) ; do not add
 * fields here, extend {@link TeammateEnvelopeV2} instead.
 * @public
 */
export interface TeammateEnvelopeV1 {
  readonly v: 1;
  readonly id: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly replyTo?: string;
  /** Unix epoch milliseconds, from the injected ClockPort. */
  readonly sentAt: number;
  readonly claim: TeammateMessageClaim;
  /** Bounded to MAX_TEAMMATE_BODY_BYTES (UTF-8 bytes). */
  readonly body: string;
  /**
   * Ed25519 (hex) over `canonicalTeammateEnvelopeString(envelope)`. Absent
   * until signed. Install-level provenance only ; see the module doc's
   * "Honest guarantees".
   */
  readonly sig?: string;
}

/** semver for {@link TeammateEnvelopeV2} (ADR-ECO-017 schemaVersion convention). @public */
export const TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2 = "2.1.0";

/**
 * The v2 envelope (sprint-878, L2-A ; ADR-ECO-017 `schemaVersion` convention
 * replacing v1's bare `v:1` semantics for NEW envelopes). Adds:
 *   - `schemaVersion` : explicit semver, so a receiver can branch without
 *     inferring version from field presence.
 *   - `correlationId` : links a send-side audit step and a receive-side audit
 *     step across two independent run ledgers (closes the cross-ledger
 *     correlation gap TM0/TM1 left implicit).
 *   - `toSessionId?` : forward-spec for L2-B session addressing ; unused
 *     routing-wise in this sprint (the mailbox still routes by `toRunId`
 *     only, per TM2's adversarial #8).
 *   - `fromInstallId?` / `toInstallId?` (L3-B D11, schemaVersion 2.1.0 minor
 *     bump) : cross-install addressing for the ADR-ECO-112 pinned-peer
 *     regime. `fromInstallId` is the SENDER's self-declared install id
 *     (`teammate-peers.ts`'s `computeInstallId`) ; because it sits INSIDE the
 *     signed bytes (see the CRITICAL INVARIANT below), claiming a peer's id
 *     without holding their key fails verification at the receiver ; the
 *     key-lookup input is signature-covered, not a bare unauthenticated
 *     claim. `toInstallId` names the intended receiving install for the
 *     cross-machine transport (L3-B b2) ; the mailbox itself still routes by
 *     `toRunId`/`toSessionId` only. Both absent (the default) : a same-install
 *     envelope, byte-identical to the pre-D11 shape once the field is omitted
 *     from the signed bytes (see the CRITICAL INVARIANT).
 *
 * CRITICAL INVARIANT: a v2 envelope signs/verifies over v2 canonical bytes
 * INCLUDING these new fields (see `canonicalTeammateEnvelopeString`, which is
 * purely structural over whatever shape it's given ; it needed no version
 * branch to honor this). A v1 signature never covers these fields and a v2
 * signature never covers only the v1 subset ; the two are cross-incompatible
 * by construction, not by an added runtime check. Because `canonicalize()` is
 * structural (it signs whatever keys are present, nothing more), an EXISTING
 * v2 envelope built before `fromInstallId`/`toInstallId` existed omits both
 * keys entirely and its signed bytes are therefore unaffected by this
 * addition ; a pre-D11 v2 signature keeps verifying (see the
 * "old-v2-signature regression" test in teammate-message.test.ts).
 * @public
 */
export interface TeammateEnvelopeV2 {
  readonly v: 2;
  readonly schemaVersion: string;
  readonly id: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly toSessionId?: string;
  readonly replyTo?: string;
  readonly correlationId: string;
  /** Unix epoch milliseconds, from the injected ClockPort. */
  readonly sentAt: number;
  readonly claim: TeammateMessageClaim;
  /** Bounded to MAX_TEAMMATE_BODY_BYTES (UTF-8 bytes). */
  readonly body: string;
  /**
   * L3-B D11 ; the sender's self-declared cross-install id. Present only for
   * a cross-install envelope ; absent means "this install", the same-install
   * path (mailbox's D1 per-envelope key selection branches on this field).
   */
  readonly fromInstallId?: string;
  /**
   * L3-B D11 ; the intended receiving install (transport addressing for
   * L3-B b2). Not consulted by the mailbox's own runId/sessionId routing.
   */
  readonly toInstallId?: string;
  /**
   * Relayed Control W2 (ADR-ECO-118/119) ; a client-generated OPAQUE
   * correlation id a controller attaches to a `control` steer sent over the
   * blind teammate-relay, echoed back in the host's `CUSTOM_CONTROL_ACK`
   * SessionEvent (the anti-oracle verdict rides the observe leg, not a
   * synchronous response). Present only on a relayed control envelope ; absent
   * (the default, incl. every direct-POST send) it is omitted from the signed
   * bytes entirely, so `canonicalTeammateEnvelopeString` is byte-identical to a
   * pre-W2 envelope (byte-identical-off). Because `canonicalize()` is purely
   * structural, its presence is signature-covered like every other field ; a
   * forged `steerId` fails verification at the receiver.
   */
  readonly steerId?: string;
  /**
   * Ed25519 (hex) over `canonicalTeammateEnvelopeString(envelope)`. Absent
   * until signed. Install-level provenance only ; see the module doc's
   * "Honest guarantees".
   */
  readonly sig?: string;
}

/**
 * The signed, wire-stable envelope ; a v1/v2 discriminated union (narrow on
 * `.v`). Existing callers that only read the fields common to both (`id`,
 * `fromRunId`, `toRunId`, `replyTo`, `claim`, `sentAt`, `body`, `sig`) need no
 * change.
 * @public
 */
export type TeammateEnvelope = TeammateEnvelopeV1 | TeammateEnvelopeV2;

/**
 * Inputs to {@link buildTeammateEnvelope}. `id` is caller-injected (a port or a
 * plain value upstream) so builds stay deterministic under test.
 * @public
 */
export interface BuildTeammateEnvelopeInput {
  readonly id: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly replyTo?: string;
  readonly claim: TeammateMessageClaim;
  readonly body: string;
}

/**
 * Inputs to {@link buildTeammateEnvelopeV2}. Adds `correlationId` (required)
 * and `toSessionId` (optional) over the v1 shape ; see
 * {@link TeammateEnvelopeV2}.
 * @public
 */
export interface BuildTeammateEnvelopeV2Input {
  readonly id: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly toSessionId?: string;
  readonly replyTo?: string;
  readonly correlationId: string;
  readonly claim: TeammateMessageClaim;
  readonly body: string;
  /** L3-B D11 ; see {@link TeammateEnvelopeV2.fromInstallId}. */
  readonly fromInstallId?: string;
  /** L3-B D11 ; see {@link TeammateEnvelopeV2.toInstallId}. */
  readonly toInstallId?: string;
  /** Relayed Control W2 ; see {@link TeammateEnvelopeV2.steerId}. */
  readonly steerId?: string;
}

/** Injected non-determinism ports for {@link buildTeammateEnvelope}. @public */
export interface TeammateEnvelopePorts {
  /** Supplies `sentAt`. RealClock in prod, RecordedClock for replay/tests. */
  readonly clock: ClockPort;
  /**
   * Signs `canonicalTeammateEnvelopeString(envelope)`. Provenance-level only
   * (see module doc); production wiring is the CLI's install Ed25519 key
   * (packages/cli/src/attestation-store.ts), out of scope for this module.
   */
  readonly sign: SignFn;
}

/** Thrown when a required envelope field is missing or malformed. @public */
export class TeammateEnvelopeInputError extends Error {
  constructor(reason: string) {
    super(`TeammateEnvelopeInputError: ${reason}`);
    this.name = "TeammateEnvelopeInputError";
  }
}

/** Thrown when `body` exceeds {@link MAX_TEAMMATE_BODY_BYTES}. @public */
export class TeammateBodyTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `TeammateBodyTooLargeError: body is ${actualBytes} bytes, exceeds the ${maxBytes}-byte bound`,
    );
    this.name = "TeammateBodyTooLargeError";
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TeammateEnvelopeInputError(`${fieldName} is required and must be a non-empty string`);
  }
}

/**
 * Shared fail-closed validation for both {@link buildTeammateEnvelope} (v1)
 * and {@link buildTeammateEnvelopeV2} ; runs BEFORE the clock is read in
 * either builder, so a rejected build never consumes a RecordedClock tick.
 */
function validateEnvelopeCore(input: {
  readonly id: string;
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly claim: TeammateMessageClaim;
  readonly body: string;
}): void {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.fromRunId, "fromRunId");
  assertNonEmpty(input.toRunId, "toRunId");
  if (!isRecognizedClaimKind(input.claim.kind)) {
    throw new TeammateEnvelopeInputError(
      `claim.kind must be one of ${[...RECOGNIZED_CLAIM_KINDS]
        .map((k) => JSON.stringify(k))
        .join(", ")}, got ${JSON.stringify(input.claim.kind)}`,
    );
  }
  const bodyBytes = new TextEncoder().encode(input.body).length;
  if (bodyBytes > MAX_TEAMMATE_BODY_BYTES) {
    throw new TeammateBodyTooLargeError(bodyBytes, MAX_TEAMMATE_BODY_BYTES);
  }
}

/**
 * Return the canonical, signature-excluded string form of an envelope ; the
 * exact bytes {@link buildTeammateEnvelope} signs and
 * {@link verifyTeammateEnvelopeSignature} re-verifies. JCS (RFC 8785) via the
 * SAME `canonicalize()` the rest of the trace/battery substrate uses.
 * @public
 */
export function canonicalTeammateEnvelopeString(env: TeammateEnvelope): string {
  const { sig: _sig, ...rest } = env;
  return canonicalize(rest);
}

/**
 * Build and sign a teammate message envelope. Pure given fixed ports: Ed25519
 * signing is itself deterministic (RFC 8032, no random nonce), so identical
 * input plus identical `clock`/`sign` reproduce a byte-identical envelope
 * (including `sig`).
 *
 * Fail-closed on malformed input: throws {@link TeammateEnvelopeInputError} for
 * a missing `id`/`fromRunId`/`toRunId` or an unrecognised `claim.kind`, and
 * {@link TeammateBodyTooLargeError} when `body` exceeds
 * {@link MAX_TEAMMATE_BODY_BYTES}. Validation runs BEFORE the clock is read, so
 * a rejected build never consumes a RecordedClock tick.
 * @public
 */
export function buildTeammateEnvelope(
  input: BuildTeammateEnvelopeInput,
  ports: TeammateEnvelopePorts,
): TeammateEnvelopeV1 {
  validateEnvelopeCore(input);

  const core: TeammateEnvelopeV1 = {
    v: 1,
    id: input.id,
    fromRunId: input.fromRunId,
    toRunId: input.toRunId,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    sentAt: ports.clock.now(),
    claim: input.claim,
    body: input.body,
  };
  const sig = ports.sign(canonicalTeammateEnvelopeString(core));
  return { ...core, sig };
}

/**
 * Build and sign a v2 teammate message envelope ({@link TeammateEnvelopeV2}).
 * Same fail-closed validation and determinism contract as
 * {@link buildTeammateEnvelope} (v1), plus a required `correlationId`. Signs
 * over the v2 shape (schemaVersion + correlationId + toSessionId included) ;
 * see {@link TeammateEnvelopeV2}'s "CRITICAL INVARIANT" doc for why this
 * never cross-verifies against a v1 signature.
 * @public
 */
export function buildTeammateEnvelopeV2(
  input: BuildTeammateEnvelopeV2Input,
  ports: TeammateEnvelopePorts,
): TeammateEnvelopeV2 {
  validateEnvelopeCore(input);
  assertNonEmpty(input.correlationId, "correlationId");

  const core: TeammateEnvelopeV2 = {
    v: 2,
    schemaVersion: TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2,
    id: input.id,
    fromRunId: input.fromRunId,
    toRunId: input.toRunId,
    ...(input.toSessionId !== undefined ? { toSessionId: input.toSessionId } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    correlationId: input.correlationId,
    sentAt: ports.clock.now(),
    claim: input.claim,
    body: input.body,
    ...(input.fromInstallId !== undefined ? { fromInstallId: input.fromInstallId } : {}),
    ...(input.toInstallId !== undefined ? { toInstallId: input.toInstallId } : {}),
    ...(input.steerId !== undefined ? { steerId: input.steerId } : {}),
  };
  const sig = ports.sign(canonicalTeammateEnvelopeString(core));
  return { ...core, sig };
}

/** Result of {@link verifyTeammateEnvelopeSignature}. @public */
export interface TeammateEnvelopeVerification {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Verify an envelope's signature against a `VerifyFn` bound to the expected
 * install public key. Returns `{valid:false}` (never throws) for a missing
 * signature, a verify-fn error, or a mismatch; the receiver treats any of
 * these as an untrusted envelope.
 * @public
 */
export function verifyTeammateEnvelopeSignature(
  env: TeammateEnvelope,
  verify: VerifyFn,
): TeammateEnvelopeVerification {
  if (typeof env.sig !== "string" || env.sig === "") {
    return { valid: false, reason: "missing signature" };
  }
  let ok = false;
  try {
    ok = verify(canonicalTeammateEnvelopeString(env), env.sig);
  } catch {
    ok = false;
  }
  return ok
    ? { valid: true }
    : {
        valid: false,
        reason: "signature does not verify against the pinned install key",
      };
}

// ─── Send-time claim-scope lens (thin over delegate.ts) ───────────────────────

/** The candidate the claim-scope lens scores (mirrors delegate.ts's GrantCandidate shape). */
interface MessageClaimCandidate {
  readonly kind: TeammateMessageClaim["kind"];
  readonly capability: string | undefined;
  readonly inScope: boolean;
}

/**
 * The deterministic non-llm-judge anchor for a message claim: an "inform"
 * never needs scope; an "ask" is accepted iff its capability is a member of
 * the sender's attenuated tool set (membership is precomputed by the caller
 * via the SAME `baseToolName()` normalization delegate.ts uses; adversarial
 * #5). Fail-closed: an "ask" with no declared capability has nothing to verify
 * and is denied.
 * @public
 */
export const messageClaimScopeLens: BatteryLens<MessageClaimCandidate> = {
  verifier: {
    name: "teammate-message-claim-scope",
    evaluate: (c) => {
      // Only an "ask" is scope-checked on this axis ; inform + list_targets are
      // HITL-exempt control-plane kinds with no capability to verify
      // (isHitlGatableClaimKind), and "control" is deliberately NOT gated here
      // either : its gate is RECEIVER-side (controllerControlScopeLens,
      // ADR-ECO-118, Task 2). A future 5th claim kind must add an explicit
      // branch below, never fall through into the "ask" wording by accident.
      const ok = c.kind !== "ask" || c.inScope;
      const rationale =
        c.kind === "inform"
          ? "inform claim: no capability scope check required"
          : c.kind === "list_targets"
            ? "list_targets claim: no capability scope check required (control-plane, HITL-exempt)"
            : c.kind === "control"
              ? "control claim: not gated on the agent 'ask' axis ; receiver-side controllerControlScopeLens is the gate (ADR-ECO-118)"
              : c.capability === undefined
                ? "ask claim: no capability declared ; fail-closed (nothing to verify)"
                : c.inScope
                  ? `ask claim: capability "${c.capability}" is in the sender's attenuated scope`
                  : `ask claim: capability "${c.capability}" is not in the sender's attenuated scope`;
      return { score: ok ? 1 : 0, rationale };
    },
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

/**
 * The claim verdict: allowed/reason plus the ONE audit step (accept or
 * denial) shaped for the TM0 per-run TraceAccumulator.
 * @public
 */
export interface MessageClaimVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  readonly auditStep: BatteryTraceStep;
}

/** Injected ports for {@link verifyMessageClaim}. @public */
export interface VerifyMessageClaimOptions {
  readonly clock: ClockPort;
}

/**
 * Fail-closed verification of `envelope.claim` against the SENDER's own
 * delegated tool scope (`senderAttenuatedTools`, e.g. `DelegationPlan.
 * attenuatedTools` from `delegate()`). An "ask" whose `capability` is not in
 * that scope is REJECTED here, before the envelope reaches the mailbox
 * (adversarial #5); this constrains the sender's requests only ; the
 * receiver's own ActionGate remains the sole execution enforcement (module
 * doc "Honest guarantees").
 *
 * Reuses `runVerifierBattery()` (the SAME audit-step construction utility
 * `delegate()` calls) with one new lens ({@link messageClaimScopeLens}), so the
 * returned `auditStep` is the SAME `BatteryTraceStep` shape a delegation-grant
 * decision produces and folds into the SAME per-run TraceAccumulator
 * (spawn-child-agent.ts, TM0) with no adapter. The audit step's `runId` is
 * `envelope.fromRunId` ; the sender's OWN run, matching the accumulator it
 * folds into.
 * @public
 */
export async function verifyMessageClaim(
  envelope: TeammateEnvelope,
  senderAttenuatedTools: readonly string[],
  opts: VerifyMessageClaimOptions,
): Promise<MessageClaimVerdict> {
  const scope = new Set(senderAttenuatedTools.map(baseToolName));
  const capability = envelope.claim.capability;
  const inScope = capability !== undefined && scope.has(baseToolName(capability));
  const candidate: MessageClaimCandidate = {
    kind: envelope.claim.kind,
    capability,
    inScope,
  };

  const decision = await runVerifierBattery<MessageClaimCandidate>(
    {
      envelopeId: envelope.id,
      fromRunId: envelope.fromRunId,
      toRunId: envelope.toRunId,
    },
    [candidate],
    [messageClaimScopeLens],
    { runId: envelope.fromRunId, adrEco: DELEGATION_ADR, clock: opts.clock },
  );

  const allowed = decision.accepted !== null;
  // "control" is intentionally NOT gated on this ask/inform/list_targets axis ;
  // its receiver-side gate is controllerControlScopeLens (ADR-ECO-118, Task 2).
  // A future 5th claim kind must add an explicit branch here, never fall
  // through into the "ask" wording by accident.
  const reason = allowed
    ? candidate.kind === "inform"
      ? "inform claim accepted: no capability scope check required"
      : candidate.kind === "list_targets"
        ? "list_targets claim accepted: no capability scope check required (control-plane, HITL-exempt)"
        : candidate.kind === "control"
          ? "control claim accepted: not gated on the agent 'ask' axis ; receiver-side controllerControlScopeLens is the gate (ADR-ECO-118)"
          : `ask claim accepted: capability "${capability}" is in the sender's attenuated scope`
    : capability === undefined
      ? "ask claim denied (fail-closed): no capability declared ; nothing to verify"
      : `ask claim denied (fail-closed): capability "${capability}" is not in the sender's attenuated scope`;

  return { allowed, reason, auditStep: decision.auditStep };
}

// ─── Control claim (SP1 ; governed controller principal) ──────────────────────
//
// A control claim carries a ControlVerb (in `claim.capability`) that a
// control-granted, boundary-authenticated HUMAN peer exercises against a running
// session. It is checked RECEIVER-side by controllerControlScopeLens (contrast
// messageClaimScopeLens, checked send-side for the agent "ask" axis). The two
// axes are orthogonal ; neither weakens the other.

/** The verbs a controller may exercise, grouped by the scope they require.
 * @public @experimental */
export type ControlVerb =
  | "observe"
  | "status"
  | "approve"
  | "reject"
  | "veto"
  | "revive"
  | "steer"
  | "whisper"
  | "stop"
  // SP-A W2 (ADR-ECO-126 §A3) ; a REAL user turn, DISTINCT from `steer` (a
  // mid-run instruction folded into the running turn). `message` feeds the
  // session's real user-input entry point : idle -> a new turn, running -> the
  // immediately-next turn ; the same semantics as typing at the local prompt.
  | "message"
  // SP-B (ADR-ECO-126 pillar 3) ; act on the TEAM, not a single running
  // session. Each carries a JSON-encoded STRUCTURED body (contrast the opaque
  // body string of steer/message) parsed fail-closed by the team-action-body
  // parsers below. `team-list` reads the roster (read-only) ; `team-send`
  // (a governed teammate message), `delegate` (a governed sub-agent), and
  // `coordinate` (a governed multi-branch workflow) spawn governed team work
  // and require `full` (SP-B DECISION 2, no new scope tier).
  | "team-list"
  | "team-send"
  | "delegate"
  | "coordinate"
  // SP-C.1 (ADR-ECO-126 pillar 4) ; START a session of a given origin. Every
  // verb above drives a session a human already started ; this one PRODUCES
  // one, which is why it is a strictly higher power (see the scope table).
  | "start"
  // C3 (session-dans-la-poche) ; request a REPLAY of the session's ring backlog
  // (the host re-pushes hub.backlog() so a reconnecting controller converges,
  // dedup by seq client-side). A pure read of already-signed events, so it sits
  // with observe/status at `read-only`. Schema + scope only here ; the host
  // handling (re-push + rate limit) is a separate task.
  | "sync";

/** Every recognized control verb ; a claim.capability outside this set is
 * denied fail-closed (nothing to authorize). @public @experimental */
export const CONTROL_VERBS: ReadonlySet<ControlVerb> = new Set([
  "observe",
  "status",
  "approve",
  "reject",
  "veto",
  "revive",
  "steer",
  "whisper",
  "stop",
  "message",
  "team-list",
  "team-send",
  "delegate",
  "coordinate",
  "start",
  "sync",
]);

/** Narrowing guard for a control verb string. @public @experimental */
export function isControlVerb(v: string): v is ControlVerb {
  return CONTROL_VERBS.has(v as ControlVerb);
}

/** True iff `kind` is the control claim kind. @public @experimental */
export function isControlClaimKind(kind: TeammateMessageClaim["kind"]): kind is "control" {
  return kind === "control";
}

/** A device-scoped control grant. Reuses the remote-control scope total order
 * verbatim (read-only < approve-only < full) ; the grant lives on the peer
 * IDENTITY (a receiver-side PeerRecord field), never self-asserted in the
 * envelope. @public @experimental */
export type ControlScope = SubTokenScope;

/**
 * Verb -> required control scope. A PARITY PORT of the per-route
 * `requireScope(...)` gates in `remote/http-server.ts` (see the parity test in
 * control-claim.test.ts) ; the cost-gate-vs-Rego parity mandate applied here.
 * Total over {@link ControlVerb} (default-deny by construction : an unlisted
 * verb cannot exist in the type). @public @experimental
 */
export const CONTROL_VERB_REQUIRED_SCOPE: Readonly<Record<ControlVerb, ControlScope>> = {
  observe: "read-only",
  status: "read-only",
  approve: "approve-only",
  reject: "approve-only",
  veto: "approve-only",
  revive: "approve-only",
  steer: "full",
  whisper: "full",
  stop: "full",
  // A real user turn can start arbitrary agent work, so it is at least as
  // powerful as `steer` ; `full`. No http-route port : the interactive session
  // routes it to the real user-input entry point (cmd-chat.ts onUserMessage).
  message: "full",
  // SP-B (ADR-ECO-126 pillar 3, DECISION 2) ; team-list is a read of the
  // roster ; the three that spawn governed team work require `full` (no new
  // scope tier). No http-route port : W2 wires them into the teammate control
  // transport (remote-machinery.ts onTeamAction).
  "team-list": "read-only",
  "team-send": "full",
  delegate: "full",
  coordinate: "full",
  // SP-C.1 ; starting a session is strictly higher power than driving one, so
  // `full` is the FLOOR, not the whole gate. Two further gates sit ABOVE this
  // scope, because a scope tier alone must not let a phone tap spawn autonomous
  // compute : the host's opt-in team-actions flag (default OFF), and, for the
  // pod origin (SP-C.2), T4 founder-approval + an L3 anchor per action. No new
  // scope tier (the SP-B DECISION 2 discipline : the tier vocabulary stays a
  // total order of three).
  start: "full",
  // C3 (session-dans-la-poche) ; a backlog REPLAY request. A pure read of
  // already-signed ring events (no state change, no new work), so it sits with
  // observe/status at `read-only`. No http route ; the host re-pushes
  // hub.backlog() (handling wired in a later task).
  sync: "read-only",
};

/** The control scope a verb requires. @public @experimental */
export function requiredScopeForControlVerb(v: ControlVerb): ControlScope {
  return CONTROL_VERB_REQUIRED_SCOPE[v];
}

/** ADR governing the control-scope lens below. Confirm the allocated number at
 * ADR draft ; ADR-ECO-118 is the presumptive next id (ADR-ECO-117 is the latest
 * accepted CC decision). @public @experimental */
export const CONTROLLER_CONTROL_ADR = "ADR-ECO-118";

/** The candidate the control-scope lens scores. Mirrors the shape discipline of
 * {@link messageClaimScopeLens}'s candidate : membership/coverage is precomputed
 * by the caller (verifyControlClaim) so the lens stays a pure, deterministic
 * scoring rule. */
interface ControlScopeCandidate {
  readonly verb: string;
  readonly grant: ControlScope | undefined;
  readonly requiredScope: ControlScope | undefined;
  readonly covered: boolean;
}

/**
 * The deterministic non-llm-judge anchor for the human-control axis : accepted
 * iff the resolved control grant COVERS the verb's required scope
 * (`scopeCovers(grant, requiredScopeForControlVerb(verb))`, precomputed by the
 * caller (verifyControlClaim) into `covered`). Fail-closed : an absent grant or
 * an unrecognized verb yields `covered:false` upstream, so the lens scores 0
 * and the battery selects `null`. Same shape (polarity affirm, criticality
 * hard, engine rule) as {@link messageClaimScopeLens}, so its ONE audit step
 * folds into the SAME per-run TraceAccumulator with no adapter.
 * @public @experimental
 */
export const controllerControlScopeLens: BatteryLens<ControlScopeCandidate> = {
  verifier: {
    name: "controller-control-scope",
    evaluate: (c) => ({
      score: c.covered ? 1 : 0,
      rationale: c.covered
        ? `control verb "${c.verb}" authorized : grant "${c.grant}" covers required "${c.requiredScope}"`
        : c.grant === undefined
          ? `control verb "${c.verb}" denied (fail-closed) : no control grant on this peer`
          : c.requiredScope === undefined
            ? `control verb "${c.verb}" denied (fail-closed) : unrecognized verb`
            : `control verb "${c.verb}" denied (fail-closed) : grant "${c.grant}" below required "${c.requiredScope}"`,
    }),
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

/** The control verdict : allowed/reason plus the ONE audit step (accept or
 * denial) shaped for the receiving run's TraceAccumulator. Mirrors
 * {@link MessageClaimVerdict}. @public @experimental */
export interface ControlClaimVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  readonly verb: string;
  readonly requiredScope: ControlScope | undefined;
  readonly grant: ControlScope | undefined;
  readonly auditStep: BatteryTraceStep;
}

/** Injected ports for {@link verifyControlClaim}. @public @experimental */
export interface VerifyControlClaimOptions {
  readonly clock: ClockPort;
}

/**
 * Fail-closed RECEIVER-side verification of a `control` claim against the
 * control grant resolved from the sender's PEER IDENTITY (never the envelope).
 * The verb is read from `envelope.claim.capability` ; a non-verb or an
 * absent/insufficient grant is denied. Mirrors {@link verifyMessageClaim} but
 * on the human-control axis : the audit step's `runId` is `envelope.toRunId`
 * (the RECEIVING session's run, the accumulator it folds into), NOT the sender's
 * run (contrast the send-side scope lens). Reuses `runVerifierBattery()` with
 * {@link controllerControlScopeLens}, so the returned `auditStep` is the SAME
 * `BatteryTraceStep` shape the mailbox's other receive-side gates produce.
 * @public @experimental
 */
export async function verifyControlClaim(
  envelope: TeammateEnvelope,
  grant: ControlScope | undefined,
  opts: VerifyControlClaimOptions,
): Promise<ControlClaimVerdict> {
  // Fail-closed on the claim kind itself: a mis-routed `ask`/`inform` envelope
  // carrying a control-verb-shaped string in `capability` must NEVER be
  // evaluated as a control claim just because the verb happens to parse.
  const isControlClaim = isControlClaimKind(envelope.claim.kind);
  const verb = envelope.claim.capability ?? "";
  const knownVerb = isControlVerb(verb);
  const requiredScope = knownVerb ? requiredScopeForControlVerb(verb) : undefined;
  const covered =
    isControlClaim && knownVerb && grant !== undefined && requiredScope !== undefined
      ? scopeCovers(grant, requiredScope)
      : false;

  const decision = await runVerifierBattery<ControlScopeCandidate>(
    { envelopeId: envelope.id, fromRunId: envelope.fromRunId, toRunId: envelope.toRunId },
    [{ verb, grant, requiredScope, covered }],
    [controllerControlScopeLens],
    { runId: envelope.toRunId, adrEco: CONTROLLER_CONTROL_ADR, clock: opts.clock },
  );

  const allowed = decision.accepted !== null;
  // Reason precedence mirrors controllerControlScopeLens's own rationale order
  // (no-grant, then unrecognized-verb, then below-required) with the new
  // kind guard placed FIRST, ahead of unknown-verb.
  const reason = allowed
    ? `control verb "${verb}" authorized : grant "${grant}" covers required "${requiredScope}"`
    : !isControlClaim
      ? `control verb "${verb}" denied (fail-closed) : not a control claim`
      : grant === undefined
        ? `control verb "${verb}" denied (fail-closed) : no control grant on this peer`
        : !knownVerb
          ? `control verb "${verb}" denied (fail-closed) : unrecognized verb`
          : `control verb "${verb}" denied (fail-closed) : grant "${grant}" below required "${requiredScope}"`;

  return { allowed, reason, verb, requiredScope, grant, auditStep: decision.auditStep };
}

// ─── Team-action bodies (SP-B ; ADR-ECO-126 pillar 3) ─────────────────────────
//
// Four control verbs act on the TEAM rather than a single running session :
// `team-list` (read the roster x live sessions), `team-send` (a governed
// teammate message to another fleet peer/session), `delegate` (a governed
// sub-agent for a subtask), `coordinate` (a governed multi-branch workflow).
// They ride the SAME control envelope as steer/message/observe (a ControlVerb
// in `claim.capability`, gated receiver-side by controllerControlScopeLens
// above), but where steer/message carry an OPAQUE instruction string in `body`,
// a team verb carries a JSON-encoded STRUCTURED body. The parsers below turn
// that raw string into a typed struct FAIL-CLOSED : a non-JSON body, a
// wrong-typed field, an out-of-range value, or an unexpected key throws
// {@link TeamActionBodyError} and the host NEVER acts on a partial.
//
// This is the pure protocol layer (SP-B W1) : no host wiring and no crypto. The
// host wiring (onTeamAction -> teammate send / delegate() / GovernedWorkflow),
// the opt-in `enableTeamActions` gate for the write verbs, and the audit-step
// fold live in W2 ; the PWA surface in W3.
//
// The task/message strings are opaque DATA, never instructions to the host
// (SP-B DECISION 4 ; a delegated task is `<external_data>`). The parsers never
// echo a field VALUE into an error message (no raw PII leak) ; an error names
// only the verb, the field, and structural facts (an unexpected KEY name is
// schema, not content).

/** The four SP-B control verbs that carry a structured team-action body ; a
 * subset of {@link ControlVerb} (the other verbs carry an opaque body string).
 * @public @experimental */
export type TeamActionVerb = "team-list" | "team-send" | "delegate" | "coordinate" | "start";

/** The team-action verbs as a set, for a runtime membership test. @public @experimental */
export const TEAM_ACTION_VERBS: ReadonlySet<ControlVerb> = new Set<ControlVerb>([
  "team-list",
  "team-send",
  "delegate",
  "coordinate",
  // SP-C.1 ; `start` belongs to this family on BOTH its defining traits : it
  // acts on the TEAM (it creates a teammate rather than driving one) and it
  // carries a structured JSON body, so it rides the same fail-closed parse ->
  // governed-primitive path as the other four.
  "start",
]);

/** Narrowing guard : true iff `v` is one of the four team-action verbs. The
 * host (W2) uses it to branch a control verb to structured-body parsing rather
 * than the opaque-body path. @public @experimental */
export function isTeamActionVerb(v: string): v is TeamActionVerb {
  return TEAM_ACTION_VERBS.has(v as ControlVerb);
}

/**
 * Thrown when a team-action `body` string is malformed : not JSON, not an
 * object, a missing/blank required field, a wrong-typed field, or an unexpected
 * key. Fail-closed : a parser throws this rather than return a partial struct.
 * Carries the `verb` and a structural `reason` ; it NEVER embeds a field VALUE
 * (no raw PII leak, SP-B DECISION 4).
 * @public @experimental
 */
export class TeamActionBodyError extends Error {
  constructor(
    public readonly verb: string,
    public readonly reason: string,
  ) {
    super(`TeamActionBodyError [${verb}]: ${reason}`);
    this.name = "TeamActionBodyError";
  }
}

/** Parsed `team-list` body : read the roster x live sessions. Empty today ; an
 * optional `filter` is a forward-compatible narrowing hint, opaque to this
 * layer. @public @experimental */
export interface TeamListRequest {
  readonly filter?: string;
}

/** Parsed `team-send` body : a governed teammate message (ask/inform) to another
 * fleet peer or session. `toTarget` is a peer/session ref (e.g. "<peer>:<name>"
 * or a runId) resolved by the host (W2), opaque here. @public @experimental */
export interface TeamSendRequest {
  readonly toTarget: string;
  readonly kind: "ask" | "inform";
  readonly body: string;
}

/** Parsed `delegate` body : a governed sub-agent for one subtask, with an
 * optional capability grant the host attenuates against the parent surface
 * (delegate.ts, ADR-ECO-076). `task` is opaque `<external_data>`.
 * @public @experimental */
export interface TeamDelegateRequest {
  readonly task: string;
  readonly grant?: { readonly tools?: readonly string[] };
}

/** Parsed `coordinate` body : a governed multi-branch workflow over 1..N
 * branches, each a subtask string (GovernedWorkflow, ADR-ECO-083). Each `task`
 * is opaque `<external_data>`. @public @experimental */
export interface TeamCoordinateRequest {
  readonly branches: readonly { readonly task: string }[];
}

/**
 * Parsed `start` body (SP-C.1) : START a session of `origin` on the work `task`,
 * optionally under a stable `name`, a `repo` for an origin that clones one (the
 * pod, SP-C.2), and a capability `grant` the host attenuates against its own
 * surface. `task` and `repo` are opaque `<external_data>`.
 *
 * The `origin` is validated against the VOCABULARY here
 * ({@link SessionOriginKind}) ; whether that origin is actually IMPLEMENTED is
 * the host's call, and an unimplemented kind fails closed at the host's executor
 * rather than at this parser. Keeping the two apart is what lets the pod origin
 * (SP-C.2) ship with no protocol change.
 * @public @experimental
 */
export interface TeamStartRequest {
  readonly origin: SessionOriginKind;
  readonly task: string;
  readonly name?: string;
  readonly repo?: string;
  readonly grant?: { readonly tools?: readonly string[] };
}

/** The parsed struct for any team-action verb ; the return of the
 * {@link parseTeamActionBody} dispatcher. @public @experimental */
export type TeamActionRequest =
  | TeamListRequest
  | TeamSendRequest
  | TeamDelegateRequest
  | TeamCoordinateRequest
  | TeamStartRequest;

/** Parse `raw` into a plain object fail-closed. Rejects non-JSON, a JSON
 * primitive, and a JSON array ; only an object body is valid for a team verb. */
function parseTeamBodyObject(raw: string, verb: TeamActionVerb): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TeamActionBodyError(verb, "body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TeamActionBodyError(verb, "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Reject any key on `obj` outside `allowed` (additionalProperties:false). A key
 * NAME is schema, not content, so it is safe to name in the error. */
function rejectUnexpectedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  verb: TeamActionVerb,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new TeamActionBodyError(
        verb,
        `unexpected key "${key}" (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

/** The shared required-field test : a non-blank string (trimmed). Doubles as a
 * type guard so a validated value narrows to `string`. */
function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Parse a `team-list` body. Accepts `"{}"`, an empty/whitespace-only body (the
 * natural no-argument form for this read verb : a phone tapping "list team"
 * sends no body), or `{"filter":"<non-blank>"}`. Fail-closed on any other shape.
 * @public @experimental
 */
export function parseTeamListBody(raw: string): TeamListRequest {
  if (raw.trim().length === 0) {
    return {};
  }
  const obj = parseTeamBodyObject(raw, "team-list");
  rejectUnexpectedKeys(obj, ["filter"], "team-list");
  const { filter } = obj;
  if (filter === undefined) {
    return {};
  }
  if (!isNonBlankString(filter)) {
    throw new TeamActionBodyError("team-list", "filter, when present, must be a non-blank string");
  }
  return { filter };
}

/**
 * Parse a `team-send` body : `{ toTarget, kind: "ask"|"inform", body }`, all
 * required, `toTarget`/`body` non-blank. Fail-closed. @public @experimental
 */
export function parseTeamSendBody(raw: string): TeamSendRequest {
  const obj = parseTeamBodyObject(raw, "team-send");
  rejectUnexpectedKeys(obj, ["toTarget", "kind", "body"], "team-send");
  const { toTarget, kind, body } = obj;
  if (!isNonBlankString(toTarget)) {
    throw new TeamActionBodyError(
      "team-send",
      "toTarget is required and must be a non-blank string",
    );
  }
  if (kind !== "ask" && kind !== "inform") {
    throw new TeamActionBodyError("team-send", 'kind is required and must be "ask" or "inform"');
  }
  if (!isNonBlankString(body)) {
    throw new TeamActionBodyError("team-send", "body is required and must be a non-blank string");
  }
  return { toTarget, kind, body };
}

/**
 * Parse a `delegate` body : `{ task, grant?: { tools?: string[] } }`. `task`
 * required non-blank ; `grant`, when present, is an object whose optional
 * `tools` is an array of non-blank strings. Fail-closed : a well-formed `task`
 * with a malformed `grant` throws rather than returning `{ task }`.
 * @public @experimental
 */
export function parseTeamDelegateBody(raw: string): TeamDelegateRequest {
  const obj = parseTeamBodyObject(raw, "delegate");
  rejectUnexpectedKeys(obj, ["task", "grant"], "delegate");
  const { task, grant } = obj;
  if (!isNonBlankString(task)) {
    throw new TeamActionBodyError("delegate", "task is required and must be a non-blank string");
  }
  if (grant === undefined) {
    return { task };
  }
  return { task, grant: parseToolGrant(grant, "delegate") };
}

/** Parse an optional `grant` object (the `{ tools? }` capability shape shared by
 * `delegate` and `start`). Fail-closed on a non-object or a `tools` that is not
 * an array of non-blank strings. `verb` only tags the error ; the validation is
 * identical, so the two verbs cannot drift apart. */
function parseToolGrant(
  raw: unknown,
  verb: TeamActionVerb,
): { readonly tools?: readonly string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TeamActionBodyError(verb, "grant, when present, must be an object");
  }
  const g = raw as Record<string, unknown>;
  rejectUnexpectedKeys(g, ["tools"], verb);
  if (g.tools === undefined) {
    return {};
  }
  if (!Array.isArray(g.tools)) {
    throw new TeamActionBodyError(
      verb,
      "grant.tools, when present, must be an array of non-blank strings",
    );
  }
  const tools: string[] = [];
  for (const tool of g.tools) {
    if (!isNonBlankString(tool)) {
      throw new TeamActionBodyError(
        verb,
        "grant.tools, when present, must be an array of non-blank strings",
      );
    }
    tools.push(tool);
  }
  return { tools };
}

/**
 * Parse a `start` body : `{ origin, task, name?, repo?, grant? }`. `origin`
 * required and a known {@link SessionOriginKind} ; `task` required non-blank ;
 * `name`, when present, non-blank ; `repo`, when present, non-blank (opaque
 * `<external_data>` ; shape is the composer's job, an origin whose substrate has
 * no repo concept ignores it) ; `grant`, when present, the shared `{ tools? }`
 * shape. Fail-closed : a well-formed `task` with a malformed `grant` throws
 * rather than silently starting an ungranted session. @public @experimental
 */
export function parseTeamStartBody(raw: string): TeamStartRequest {
  const obj = parseTeamBodyObject(raw, "start");
  rejectUnexpectedKeys(obj, ["origin", "task", "name", "repo", "grant"], "start");
  const { origin, task, name, repo, grant } = obj;
  // The origin NAME is schema, not content ; but an unknown one is still
  // reported structurally (never echoed) to keep every parser's discipline
  // uniform.
  if (typeof origin !== "string" || !isSessionOriginKind(origin)) {
    throw new TeamActionBodyError(
      "start",
      "origin is required and must be a known session origin kind",
    );
  }
  if (!isNonBlankString(task)) {
    throw new TeamActionBodyError("start", "task is required and must be a non-blank string");
  }
  if (name !== undefined && !isNonBlankString(name)) {
    throw new TeamActionBodyError("start", "name, when present, must be a non-blank string");
  }
  if (repo !== undefined && !isNonBlankString(repo)) {
    throw new TeamActionBodyError("start", "repo, when present, must be a non-blank string");
  }
  return {
    origin,
    task,
    ...(name !== undefined ? { name } : {}),
    ...(repo !== undefined ? { repo } : {}),
    ...(grant !== undefined ? { grant: parseToolGrant(grant, "start") } : {}),
  };
}

/**
 * Parse a `coordinate` body : `{ branches: [{ task }, ...] }`, 1..N branches,
 * each `task` non-blank. Fail-closed. @public @experimental
 */
export function parseTeamCoordinateBody(raw: string): TeamCoordinateRequest {
  const obj = parseTeamBodyObject(raw, "coordinate");
  rejectUnexpectedKeys(obj, ["branches"], "coordinate");
  const rawBranches = obj.branches;
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    throw new TeamActionBodyError(
      "coordinate",
      "branches is required and must be a non-empty array",
    );
  }
  const branches = rawBranches.map((entry, i) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TeamActionBodyError("coordinate", `branches[${i}] must be an object`);
    }
    const branch = entry as Record<string, unknown>;
    rejectUnexpectedKeys(branch, ["task"], "coordinate");
    const { task } = branch;
    if (!isNonBlankString(task)) {
      throw new TeamActionBodyError(
        "coordinate",
        `branches[${i}].task is required and must be a non-blank string`,
      );
    }
    return { task };
  });
  return { branches };
}

/**
 * Discriminate on the verb and parse `raw` with the matching per-verb parser
 * ({@link parseTeamListBody} / {@link parseTeamSendBody} /
 * {@link parseTeamDelegateBody} / {@link parseTeamCoordinateBody}) : the verb
 * determines the validator. A caller that already knows the verb statically may
 * call the specific parser directly. Fail-closed : throws
 * {@link TeamActionBodyError} on a malformed body or a non-team verb.
 * @public @experimental
 */
export function parseTeamActionBody(verb: TeamActionVerb, raw: string): TeamActionRequest {
  switch (verb) {
    case "team-list":
      return parseTeamListBody(raw);
    case "team-send":
      return parseTeamSendBody(raw);
    case "delegate":
      return parseTeamDelegateBody(raw);
    case "coordinate":
      return parseTeamCoordinateBody(raw);
    case "start":
      return parseTeamStartBody(raw);
    default: {
      // Exhaustive over TeamActionVerb ; a runtime value outside the union (an
      // untyped caller passing a non-team verb) is rejected fail-closed.
      const exhaustive: never = verb;
      throw new TeamActionBodyError(String(exhaustive), "not a team-action verb");
    }
  }
}
