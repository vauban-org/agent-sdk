/**
 * remote/events — the SessionEvent schema for remote agent control.
 *
 * A running agent emits a stream of `SessionEvent`s; a remote client (a phone
 * app, a browser, another terminal) consumes them to observe — and intervene
 * on — the work in progress.
 *
 * The schema is aligned with the **AG-UI Protocol** (Agent-User Interaction
 * Protocol — the emerging standard adopted by AWS Bedrock AgentCore, Google,
 * CopilotKit). Event `type` strings mirror AG-UI's canonical vocabulary
 * (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, etc.). Vauban
 * extensions with no AG-UI peer are projected onto `CUSTOM_*` names so the
 * conformance suite's closed-vocabulary check still passes.
 *
 * Two Vauban extensions go beyond AG-UI:
 *   - `CUSTOM_TOOL_INTENT` — the agent announces what it is ABOUT to do before
 *     doing it (the "veto window" — transparency before action, not after).
 *   - every event carries an optional `sig` field — an Ed25519 signature of
 *     the canonical event, so the remote-control transcript is itself a
 *     tamper-evident audit trail (EU AI Act Art. 12).
 *
 * Legacy dotted-lowercase types (`run.start`, `assistant.delta`, …) emitted
 * before 3.0.0 are still accepted by `looksLikeSessionEvent` for replay
 * compatibility but are no longer emitted by the hub.
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

import { z } from "zod";

import { isKnownEventType } from "./event-name-map.js";

// ─── Event payloads ──────────────────────────────────────────────────────────

/** The run began. Mirrors AG-UI RUN_STARTED. */
export const RunStartPayloadSchema = z
  .object({
    runId: z.string(),
    agentId: z.string(),
    agentVersion: z.string().optional(),
    /** The user message / task that started the run. */
    task: z.string().optional(),
    startedAt: z.string(),
    /**
     * Where the turn that opened this run came from. Absent = local (the
     * pre-existing behavior, byte-identical) ; "remote" = the turn was
     * queued by a teammate/controller message rather than typed at the
     * local prompt. A local turn never sets this field.
     */
    origin: z.enum(["local", "remote"]).optional(),
    /**
     * The client-generated, opaque correlation id carried on the control
     * envelope that opened this run (a `message` claim's `steerId` ; the
     * SAME field `ControlAckPayloadSchema.steerId` correlates an ack to).
     * Absent for a local turn or a remote turn whose claim carried none
     * (byte-identical to before this field existed). Lets a controller
     * resolve its own optimistic echo by identity instead of by matching
     * text against the timeline (sprint-1067 t3-steerid-correlation).
     */
    steerId: z.string().optional(),
  })
  .strict();

/** A loop step completed. Vauban granularity on top of AG-UI. */
export const RunStepPayloadSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

/** A streamed assistant token delta. Mirrors AG-UI TEXT_MESSAGE_CONTENT. */
export const AssistantDeltaPayloadSchema = z.object({ text: z.string() }).strict();

/** A complete assistant message for a step. Mirrors AG-UI TEXT_MESSAGE_END. */
export const AssistantMessagePayloadSchema = z.object({ content: z.string() }).strict();

/**
 * The agent ANNOUNCES a tool call before executing it — the veto window.
 * Vauban extension: no AG-UI equivalent. A remote client gets a chance to
 * reject during `vetoWindowMs` before the call runs.
 */
export const ToolIntentPayloadSchema = z
  .object({
    callId: z.string(),
    toolName: z.string(),
    /** Canonical, possibly-truncated args preview. */
    argsPreview: z.string(),
    /** One-line rationale: why the agent intends this call. */
    rationale: z.string().optional(),
    /** Milliseconds the client has to veto before the call proceeds. */
    vetoWindowMs: z.number().int().nonnegative(),
  })
  .strict();

/** A tool call started. Mirrors AG-UI TOOL_CALL_START. */
export const ToolCallStartPayloadSchema = z
  .object({
    callId: z.string(),
    toolName: z.string(),
    argsPreview: z.string(),
  })
  .strict();

/** A tool call finished. Mirrors AG-UI TOOL_CALL_END. */
export const ToolCallEndPayloadSchema = z
  .object({
    callId: z.string(),
    toolName: z.string(),
    ok: z.boolean(),
    /** Truncated result/output summary. */
    resultPreview: z.string(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Risk metadata mirrored from `ApprovalRisk` (hitl/approval-channel.ts) for
 * the phone/PWA HITL ceremony display. Display-only — basis: declared ; never
 * a decision input.
 * @since sprint-1067 (risk-vector-wire)
 */
export const HitlRiskPayloadSchema = z
  .object({
    score: z.number().min(0).max(1),
    reversibility: z.number().min(0).max(1),
    blastRadius: z.number().min(0).max(1),
    dataSensitivity: z.number().min(0).max(1),
    externalSideEffect: z.number().min(0).max(1),
  })
  .strict();

/** A HITL approval is pending. Mirrors AG-UI RUN_FINISHED(interrupt). */
export const HitlRequestPayloadSchema = z
  .object({
    requestId: z.string(),
    action: z.string(),
    context: z.string(),
    /** Deadline after which the timeout policy fires (ISO8601). */
    expiresAt: z.string().optional(),
    /**
     * Optional risk metadata mirrored from the tool's RiskVector. Additive ;
     * absent when the tool declares no RiskVector.
     * @since sprint-1067 (risk-vector-wire)
     */
    risk: HitlRiskPayloadSchema.optional(),
  })
  .strict();

/** A HITL request was resolved. */
export const HitlResolvedPayloadSchema = z
  .object({
    requestId: z.string(),
    approved: z.boolean(),
    by: z.string(),
  })
  .strict();

/** A remote client injected an instruction into the running session. */
export const InstructionInjectedPayloadSchema = z
  .object({
    text: z.string(),
    source: z.string(),
    /** When true, the instruction steers but is not shown as a user turn. */
    whisper: z.boolean().default(false),
    /**
     * The client-generated, opaque correlation id carried on the control
     * envelope that queued this instruction (a `steer`/`whisper` claim's
     * `steerId`). Absent for an instruction with no originating claim id
     * (byte-identical to before this field existed) ; see
     * `RunStartPayloadSchema`'s `steerId` for the sibling on the `message`
     * rail (sprint-1067 t3-steerid-correlation).
     */
    steerId: z.string().optional(),
  })
  .strict();

/**
 * A message from a paired teammate cleared the receiver mailbox's gate
 * pipeline (sprint-893 d1, ZD4). Emitted ALONGSIDE `CUSTOM_INSTRUCTION_INJECTED`
 * for a delivered inform/ask ; never instead of it (additive, backward
 * compatible ; an old consumer that only understands `CUSTOM_INSTRUCTION_INJECTED`
 * keeps working unchanged). This event carries no body text: its purpose is
 * to give a remote client (phone/web) a structural signal ; origin peer, claim
 * kind, sender runId ; to render a teammate-origin delivery differently from
 * an operator's own `/remote/inject` instruction, without string-sniffing the
 * `source` field of the instruction event.
 */
export const TeammateDeliveryPayloadSchema = z
  .object({
    /** The delivered envelope's id. */
    envelopeId: z.string(),
    /** Mirrors `TeammateMessageClaim["kind"]` (agent-sdk delegation plane). */
    claimKind: z.enum(["inform", "ask", "list_targets"]),
    /** The sender's raw runId ; always present, even cross-install. */
    fromRunId: z.string(),
    /** Present iff the envelope was v2 and cross-install (ADR-ECO-112). */
    fromInstallId: z.string().optional(),
    /**
     * sprint-1067 quick-38 ; the sender's declared NAME, when the RECEIVING
     * host could resolve it from its OWN local sources (its announce registry,
     * its in-process session table, its pinned-peer alias cache). Structural
     * metadata, resolved receiver-side : it is never taken from the message
     * body and never self-asserted by the sender, so an `<external_data>`
     * spotlight boundary is never crossed to produce it (ADR-ECO-109).
     *
     * A controller that already knows the peer keeps resolving the name from
     * its own roster (fresher across a rename) ; this field is what lets it
     * name a sender it has no way to know — a sibling session on the host's
     * install that never announced to the fleet. Absent = unresolved, and the
     * consumer keeps its honest generic fallback.
     */
    fromName: z.string().optional(),
    /** Present only for an "ask". */
    capability: z.string().optional(),
    /**
     * sprint-1067 T3 ; present iff this delivery ANSWERS an ask this session
     * sent : the id of the envelope that asked. A controller's thread renders
     * it as "réponse de <origine>" instead of one more incoming message, which
     * is what closes the ask round-trip visually. Absent for every other
     * delivery (byte-identical to a build before the reply rail existed).
     */
    replyTo: z.string().optional(),
  })
  .strict();

/** The run finished. Mirrors AG-UI RUN_FINISHED. */
export const RunFinishedPayloadSchema = z
  .object({
    runId: z.string(),
    stopReason: z.string(),
    stepCount: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    finishedAt: z.string(),
  })
  .strict();

/**
 * The host's anti-oracle verdict for one relayed control steer (Relayed
 * Control W2, ADR-ECO-118/119). Emitted onto the observe leg as a signed
 * `CUSTOM_CONTROL_ACK` event so it rides the existing E2E-signed stream ; the
 * controller correlates it to its steer by the client-generated `steerId`.
 *
 * ANTI-ORACLE INVARIANT: `accepted` is the ONLY auth signal on the wire. A
 * scope-deny surfaces as `accepted:true` (indistinguishable from a real
 * accept ; the host records `denied_control_scope` in its LOCAL ledger only),
 * an auth-fail as `accepted:false`. `verdict` is optional, human-facing, and
 * MUST NOT encode the scope/auth outcome (it never distinguishes a scope-deny
 * from a real accept) ; it is a free-form label a UI may render.
 */
export const ControlAckPayloadSchema = z
  .object({
    /** The client-generated opaque correlation id echoed from the steer envelope. */
    steerId: z.string(),
    /** The ONLY auth signal: true = delivered+authed (or scope-denied, anti-oracle) ; false = auth-fail. */
    accepted: z.boolean(),
    /** Optional, non-auth-bearing label (e.g. "applied") ; never a scope oracle. */
    verdict: z.string().optional(),
  })
  .strict();

/**
 * A pod-origin session was started (A', pod roster auto-discovery). Carries the
 * pod's PUBLIC fleet install cert so a starter's PWA, already observing this
 * host session's fleet-CEK-encrypted observe leg, can verify it
 * (`verifyFleetCert`) and merge it into its roster (`mergeRoster`) WITHOUT a
 * manual Add-by-install-id. Every field is public (no secret): the cert is
 * self-verifying against the fleet root the PWA already pins. This SDK schema
 * only gates transport SHAPE ; the cryptographic verification is the PWA's, not
 * this schema's. The cert shape mirrors cli `teammate-fleet.ts` FleetInstallCert
 * (agent-sdk is a lower layer and cannot import it ; the shapes are pinned by a
 * cross-impl test, same discipline as the fleet-cert vectors).
 *
 * ANTI-ORACLE: this rides the OBSERVE leg only, never the control ACK (which
 * stays `{steerId, accepted}`). A denied/failed start emits nothing.
 */
export const PodStartedFleetCertSchema = z
  .object({
    v: z.literal(1),
    fleetId: z.string().min(1),
    rootPubkey: z.string().min(1),
    signingPubkey: z.string().min(1),
    installId: z.string().min(1),
    installPubkey: z.string().min(1),
    name: z.string().optional(),
    issuedAt: z.number().int().nonnegative(),
    notAfter: z.number().int().nonnegative(),
    sig: z.string().optional(),
  })
  .strict();

/** The pod's PUBLIC fleet install cert, structurally identical to cli
 * `teammate-fleet.ts` FleetInstallCert (agent-sdk is a lower layer and cannot
 * import it ; a real FleetInstallCert assigns to this by structural typing). No
 * secret field ; self-verifying against the pinned fleet root. @public */
export type PodStartedFleetCert = z.infer<typeof PodStartedFleetCertSchema>;

export const PodStartedPayloadSchema = z
  .object({
    /** The pod's fleet install id (its addressing id). MUST equal `cert.installId`
     * ; the consumer asserts it fail-closed (anti-squat, mirrors roster-delta). */
    installId: z.string().min(1),
    /** The pod session name (`pod-<id>`) ; the steer/addressing name, distinct
     * from the cert's optional display `name`. */
    name: z.string().min(1),
    /** The pod's PUBLIC fleet install cert (self-verifying against the pinned root). */
    cert: PodStartedFleetCertSchema,
  })
  .strict();

/**
 * A fleet member's install cert was RENEWED ; the host emits this on the observe
 * leg carrying the member's freshly-minted PUBLIC fleet install cert, so a
 * browser member already watching this host session's fleet-CEK-encrypted
 * observe leg verifies it (`verifyFleetCert`) and folds the extended validity
 * window into its stored cert WITHOUT a re-key ceremony (finding #5b, 2026-07-21
 * ; today renewed certs never reach browser members, so member certs silently
 * expire and force a manual re-key).
 *
 * SIBLING OF A' (`CUSTOM_POD_STARTED`), NOT A COPY. Both carry the SAME
 * structural fleet install cert ; the only wire difference is intent (a pod
 * DISCOVERY adds a brand-new install to the roster ; a renewal EXTENDS an
 * install already known, own or sibling). The cert schema is REUSED verbatim
 * (`PodStartedFleetCertSchema`) rather than re-declared : a renewed cert and a
 * pod-start cert are the same public, self-verifying object, and the
 * pod-specific export name is incidental. The consumer decides own-vs-sibling
 * and applies the monotonicity guard ; this schema gates transport SHAPE only.
 *
 * ANTI-ORACLE: this rides the OBSERVE leg only, never any ack (the control ACK
 * stays `{steerId, accepted}`). A renewal the host could not mint emits nothing.
 * Every field is public (no secret) ; the cert self-verifies against the fleet
 * root the member already pins, so the cryptographic verification is the
 * consumer's, not this schema's.
 */
/**
 * The root-signed signing-key cert (the root->signing link ; cli
 * `teammate-fleet.ts` FleetSigningKeyCert). A SMALLER object than the install
 * cert : no installId/installPubkey/name, only the root's authorization of a
 * short-lived signing key. Rides the renewal rail ONLY on a signing-key
 * ROTATION, so a browser member can verify a member cert minted under a NEW
 * signing key against the cert that authorizes that key, instead of failing
 * closed against a cached signing-key cert (the pre-rotation residual). Public,
 * self-verifying against the pinned root ; agent-sdk is a lower layer and cannot
 * import the cli type, so the shape is pinned by a cross-impl test, the same
 * discipline as {@link PodStartedFleetCertSchema}. `.strict()` : no secret rides
 * along (the signing PRIVATE key never leaves the primary's store).
 */
export const FleetSigningKeyCertSchema = z
  .object({
    v: z.literal(1),
    fleetId: z.string().min(1),
    rootPubkey: z.string().min(1),
    signingPubkey: z.string().min(1),
    issuedAt: z.number().int().nonnegative(),
    notAfter: z.number().int().nonnegative(),
    sig: z.string().optional(),
  })
  .strict();

/** The PUBLIC root-signed signing-key cert, structurally identical to cli
 * `teammate-fleet.ts` FleetSigningKeyCert. No secret field ; self-verifying
 * against the pinned fleet root. @public */
export type FleetSigningKeyCert = z.infer<typeof FleetSigningKeyCertSchema>;

export const CertRenewedPayloadSchema = z
  .object({
    /** The renewing member's fleet install id (its addressing id). MUST equal
     * `cert.installId` ; the consumer asserts it fail-closed (anti-squat, the
     * same `boundInstallId` bind A' uses). */
    installId: z.string().min(1),
    /** The member's freshly-renewed PUBLIC fleet install cert (a later validity
     * window, same install identity ; self-verifying against the pinned root). */
    cert: PodStartedFleetCertSchema,
    /** OPTIONAL : the root-signed signing-key cert the member cert was minted
     * under. Present ONLY when the fleet SIGNING KEY was rotated (the member
     * cert now chains to a NEW signing key the member's cached signing-key cert
     * does not authorize). Absent = exactly today's wire (a plain renewal under
     * the unchanged signing key) ; a consumer that ignores it keeps working. The
     * consumer verifies this cert chains to the pinned ROOT (which never rotates)
     * AND is strictly newer than its cached signing-key cert (rollback
     * protection) before trusting it. */
    signingKeyCert: FleetSigningKeyCertSchema.optional(),
  })
  .strict();

/** The renewed-cert observe-leg payload (finding #5b). Structurally a superset
 * of nothing new : `installId` + the reused public {@link PodStartedFleetCert}.
 * @public */
export type CertRenewedPayload = z.infer<typeof CertRenewedPayloadSchema>;

/**
 * The named stages of a pod start, in pipeline order (V2-C mission-control). The
 * enum IS the wire contract the PWA timeline renders (Vercel-style : each stage a
 * node that goes pending -> active -> done, or flips to failed). Each maps 1:1 to
 * a REAL governance boundary in the pod origin's `start()` (ADR-ECO-129) :
 *   - `requested`   ; the start was accepted and T4 founder approval is requested.
 *   - `approved`    ; T4 approval granted (a deny/timeout emits this failed).
 *   - `cert_minted` ; the pod's fleet identity + credentials are established
 *                     (L3 anchor + fleet install cert + ZSP repo token).
 *   - `committed`   ; the Job + secret manifests are committed & pushed to infra git.
 *   - `reconciling` ; Flux reconciliation / the fleet-announce wait has begun.
 *   - `announced`   ; the pod announced on the fleet ; the session is live.
 * Frozen so the tuple is the single source of the stage vocabulary. @public
 */
export const POD_START_STAGES = [
  "requested",
  "approved",
  "cert_minted",
  "committed",
  "reconciling",
  "announced",
] as const;

/**
 * A pod-start PROGRESS beat (V2-C). Emitted on the observe leg at each pipeline
 * boundary so a phone renders a live named-state timeline instead of dead silence
 * between the tap and the pod.
 *
 * ANTI-ORACLE / SPOTLIGHTING (hard) : `detail` is a STRUCTURAL reason only (e.g.
 * `denied`, `timeout`, `publish_failed`), NEVER the task/repo VALUE (`<external_data>`)
 * ; `failed` flips the stage node to a terminal-failure render. The control ACK stays
 * `{steerId, accepted}` untouched ; a progress beat never rides it. `.strict()` : no
 * field can smuggle a value alongside the structural stage.
 */
export const PodStartProgressPayloadSchema = z
  .object({
    /** The pipeline stage this beat reports (the wire contract the timeline renders). */
    stage: z.enum(POD_START_STAGES),
    /** OPTIONAL short STRUCTURAL reason (e.g. `denied`, `announce_timeout`) ; NEVER
     * the task/repo external_data value. */
    detail: z.string().optional(),
    /** OPTIONAL : true iff this stage terminated the start in failure. Absent = the
     * stage advanced normally. */
    failed: z.boolean().optional(),
  })
  .strict();

/** A pod-start progress stage name (one of {@link POD_START_STAGES}). @public */
export type PodStartProgressStage = z.infer<typeof PodStartProgressPayloadSchema>["stage"];
/** The pod-start progress observe-leg payload (V2-C). @public */
export type PodStartProgressPayload = z.infer<typeof PodStartProgressPayloadSchema>;

/**
 * One roster row a `team-list` result carries : the cross-install pinned-peer
 * addressing shape (`teammate-controller-roster.ts`'s `RosterEntry`, structural
 * only). Mirrored here rather than imported ; agent-sdk is a lower layer and
 * cannot import the cli type (same discipline as {@link PodStartedFleetCertSchema}).
 */
export const TeamActionRosterRowSchema = z
  .object({
    address: z.string(),
    runId: z.string(),
    name: z.string(),
    peerLabel: z.string().optional(),
    /** OPTIONAL (sprint-1067 T3) : `false` marks a row the host knows it cannot
     * route to right now (a live session of another process on the same
     * install ; the same-install rail only reaches sessions in the daemon's
     * process). Absent = reachability not evaluated for that row, which is the
     * pre-T3 shape and what every pinned-peer row still carries. A controller
     * renders a `false` row as visible-but-not-addressable rather than
     * offering it as a healthy target. */
    reachable: z.boolean().optional(),
  })
  .strict();

/** One of THIS host's own live announced sessions, as a `team-list` result
 * carries it (`teammate-team-actions.ts`'s `TeamLiveSession`, structural only). */
export const TeamActionLiveSessionSchema = z
  .object({
    runId: z.string(),
    name: z.string().optional(),
  })
  .strict();

/**
 * The host's structural result for ONE team action (sprint-1067 T3
 * team-actions-v2 ; ADR-ECO-126 pillar 3). Emitted on the OBSERVE leg (never
 * the control ACK, anti-oracle) so a relayed/executed team action is never
 * silently dropped : before this event existed, the host computed a
 * {@link TeamActionOutcome}-shaped result and threw it away, or an unresolvable
 * target threw out of the dispatcher uncaught ; both looked identical to the
 * controller as "ack, then total silence".
 *
 * `outcome` :
 *   - `"executed"`   ; a LOCAL host action ran (`team-list` / `delegate` /
 *     `coordinate` / `start`). `detail` carries a non-ok structural reason
 *     when the action itself failed (e.g. `"team-actions-disabled"`).
 *   - `"delivered"`  ; a `team-send` (ask/inform) was accepted by the target.
 *   - `"resolved"`   ; a `team-send` target was found (an install/session
 *     identified), but the send itself was rejected (`detail` carries the
 *     structural reason, e.g. `"send-rejected"`).
 *   - `"no-route"`   ; a `team-send` target could not be resolved at all (an
 *     unknown/ambiguous address ; the drop that used to be silent).
 *
 * `roster` rides ONLY on a `team-list` result (the read the controller asked
 * for) ; every other action carries no roster. `target` is addressing
 * (schema, never content) ; `detail` is a short STRUCTURAL reason, never a
 * task/body VALUE (`<external_data>`, SP-B DECISION 4).
 */
export const TeamActionResultPayloadSchema = z
  .object({
    action: z.enum(["team-list", "team-send", "delegate", "coordinate", "start"]),
    target: z.string().optional(),
    outcome: z.enum(["resolved", "delivered", "no-route", "executed"]),
    detail: z.string().optional(),
    roster: z
      .object({
        rows: z.array(TeamActionRosterRowSchema),
        liveSessions: z.array(TeamActionLiveSessionSchema),
      })
      .optional(),
  })
  .strict();

/**
 * A standing grant was minted from a REMOTE approval (sprint-1067 t3
 * remote-grant-scopes). The local prompt has always offered `s(ession)` /
 * `a(lways)` alongside `y` ; before this event a phone could only ever answer
 * once, and the composite dropped any scope a remote verdict carried. Now a
 * `full`-granted controller may ask for one, and every grant it mints says so
 * OUT LOUD on the observe leg : a grant that appears in the session's memory
 * with no visible trace of who created it is exactly the failure mode the
 * silent strip was protecting against.
 *
 * `scope` is what was ACTUALLY minted. `requestedScope` is present only when
 * the two differ, i.e. when the host downgraded the request : an `always` on a
 * CEREMONY-level request is never accepted remotely (the local operator keeps
 * its full `a(lways)`), so it lands as `session` and the event carries both
 * halves rather than quietly recording the smaller one.
 *
 * Every field is structural. `tool` is the tool name and `pattern` the derived
 * match pattern (`permission-store.ts`'s `deriveDefaultPattern`) ; both were
 * already visible to this controller in the `hitl.request` it just answered, so
 * this event reveals nothing new to it. `by` is the controller principal.
 */
export const RemoteGrantPayloadSchema = z
  .object({
    /** The scope actually minted. `once` never reaches here (nothing to record). */
    scope: z.enum(["session", "always"]),
    /** The tool the grant covers. */
    tool: z.string(),
    /** The derived match pattern the grant is stored under. */
    pattern: z.string(),
    /** The controller principal that asked for it (`controller:<installId>`). */
    by: z.string(),
    /** Present ONLY on a downgrade ; the scope the controller asked for. */
    requestedScope: z.enum(["session", "always"]).optional(),
    /** Present ONLY on a downgrade ; a short structural reason, never a value. */
    downgradeReason: z.string().optional(),
  })
  .strict();

/** The remote-grant observe-leg payload (sprint-1067 t3). @public */
export type RemoteGrantPayload = z.infer<typeof RemoteGrantPayloadSchema>;

/**
 * A verdict reached WITHOUT asking anyone (sprint-1067 t3 auto-approve-
 * visibility). Two mechanisms produce one : a standing grant whose pattern
 * matched the request, and the coalescence of a retry onto a recent verdict for
 * the same tool + scope + content. Both are intended behavior, and both are
 * INVISIBLE from the outside : the operator watches an action land with no card
 * and no prompt, which reads as a bypass. The fix is to say it out loud, so
 * this rides the observe leg alongside `CUSTOM_REMOTE_GRANT`.
 *
 * WHAT IT DOES NOT CARRY. Never the request's arguments or content ; only the
 * tool and the scope that matched. `.strict()` is what enforces that a future
 * caller cannot quietly attach the context blob to it.
 */
export const AutoVerdictPayloadSchema = z
  .object({
    /** Why nobody was asked : a matched standing grant, or a replayed verdict. */
    reason: z.enum(["grant", "coalesced"]),
    /** The tool the verdict covers. */
    tool: z.string(),
    /** The matched (grant) or replayed (coalesced) scope pattern. Absent for a
     * tool the grant grammar derives no pattern for. */
    pattern: z.string().optional(),
    /** The scope of the grant that matched. Grant hits only ; a coalesced
     * replay has no scope of its own (it replays one session's verdict). */
    scope: z.enum(["session", "always"]).optional(),
    /** Whether the verdict APPROVED. Mandatory, because a coalesced replay can
     * replay a refusal, and « refusé automatiquement » must not read as an
     * approval. */
    approved: z.boolean(),
  })
  .strict();

/** The auto-verdict observe-leg payload (sprint-1067 t3). @public */
export type AutoVerdictPayload = z.infer<typeof AutoVerdictPayloadSchema>;

/** A periodic snapshot of session state. Mirrors AG-UI STATE_SNAPSHOT. */
export const StatePayloadSchema = z
  .object({
    runId: z.string(),
    stepCount: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    pendingHitl: z.number().int().nonnegative(),
  })
  .strict();

// ─── The discriminated union ─────────────────────────────────────────────────

/**
 * Every event shares an envelope: a stable id, a sequence number (monotonic
 * per session — lets a reconnecting client resume without gaps), an ISO
 * timestamp, and an optional Ed25519 signature over the canonical event.
 */
const ENVELOPE = {
  /** Unique event id. */
  id: z.string(),
  /** Monotonic per-session sequence number — for gap-free reconnection. */
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  /** Ed25519 signature of the canonical event (hex). Added by `signing.ts`. */
  sig: z.string().optional(),
} as const;

/**
 * SessionEvent discriminated union — canonical AG-UI UPPER_SNAKE_CASE types
 * (3.0.0+) plus legacy dotted-lowercase shims retained for replay compatibility
 * of pre-3.0.0 serialised event streams.
 *
 * The hub only EMITS canonical types. The legacy shim entries exist so
 * `looksLikeSessionEvent`, `SessionEventSchema.safeParse`, and TypeScript
 * switch statements written against the old vocabulary continue to compile
 * and parse correctly.
 * @public
 */
export const SessionEventSchema = z.discriminatedUnion("type", [
  // ─── Canonical AG-UI types (primary — hub emits these) ────────────────────
  z.object({
    type: z.literal("RUN_STARTED"),
    ...ENVELOPE,
    data: RunStartPayloadSchema,
  }),
  z.object({
    type: z.literal("STEP_STARTED"),
    ...ENVELOPE,
    data: RunStepPayloadSchema,
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_CONTENT"),
    ...ENVELOPE,
    data: AssistantDeltaPayloadSchema,
  }),
  z.object({
    type: z.literal("TEXT_MESSAGE_END"),
    ...ENVELOPE,
    data: AssistantMessagePayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_TOOL_INTENT"),
    ...ENVELOPE,
    data: ToolIntentPayloadSchema,
  }),
  z.object({
    type: z.literal("TOOL_CALL_START"),
    ...ENVELOPE,
    data: ToolCallStartPayloadSchema,
  }),
  z.object({
    type: z.literal("TOOL_CALL_END"),
    ...ENVELOPE,
    data: ToolCallEndPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_HITL_REQUEST"),
    ...ENVELOPE,
    data: HitlRequestPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_HITL_RESOLVED"),
    ...ENVELOPE,
    data: HitlResolvedPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_INSTRUCTION_INJECTED"),
    ...ENVELOPE,
    data: InstructionInjectedPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_TEAMMATE_DELIVERY"),
    ...ENVELOPE,
    data: TeammateDeliveryPayloadSchema,
  }),
  z.object({
    type: z.literal("RUN_FINISHED"),
    ...ENVELOPE,
    data: RunFinishedPayloadSchema,
  }),
  z.object({
    type: z.literal("STATE_SNAPSHOT"),
    ...ENVELOPE,
    data: StatePayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_CONTROL_ACK"),
    ...ENVELOPE,
    data: ControlAckPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_POD_STARTED"),
    ...ENVELOPE,
    data: PodStartedPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_FLEET_CERT_RENEWED"),
    ...ENVELOPE,
    data: CertRenewedPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_POD_START_PROGRESS"),
    ...ENVELOPE,
    data: PodStartProgressPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_TEAM_ACTION_RESULT"),
    ...ENVELOPE,
    data: TeamActionResultPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_REMOTE_GRANT"),
    ...ENVELOPE,
    data: RemoteGrantPayloadSchema,
  }),
  z.object({
    type: z.literal("CUSTOM_AUTO_VERDICT"),
    ...ENVELOPE,
    data: AutoVerdictPayloadSchema,
  }),

  // ─── Legacy dotted-lowercase shims (replay compat — not emitted by hub) ───
  z.object({
    type: z.literal("run.start"),
    ...ENVELOPE,
    data: RunStartPayloadSchema,
  }),
  z.object({
    type: z.literal("run.step"),
    ...ENVELOPE,
    data: RunStepPayloadSchema,
  }),
  z.object({
    type: z.literal("assistant.delta"),
    ...ENVELOPE,
    data: AssistantDeltaPayloadSchema,
  }),
  z.object({
    type: z.literal("assistant.message"),
    ...ENVELOPE,
    data: AssistantMessagePayloadSchema,
  }),
  z.object({
    type: z.literal("tool.intent"),
    ...ENVELOPE,
    data: ToolIntentPayloadSchema,
  }),
  z.object({
    type: z.literal("tool.call.start"),
    ...ENVELOPE,
    data: ToolCallStartPayloadSchema,
  }),
  z.object({
    type: z.literal("tool.call.end"),
    ...ENVELOPE,
    data: ToolCallEndPayloadSchema,
  }),
  z.object({
    type: z.literal("hitl.request"),
    ...ENVELOPE,
    data: HitlRequestPayloadSchema,
  }),
  z.object({
    type: z.literal("hitl.resolved"),
    ...ENVELOPE,
    data: HitlResolvedPayloadSchema,
  }),
  z.object({
    type: z.literal("instruction.injected"),
    ...ENVELOPE,
    data: InstructionInjectedPayloadSchema,
  }),
  z.object({
    type: z.literal("run.finished"),
    ...ENVELOPE,
    data: RunFinishedPayloadSchema,
  }),
  z.object({ type: z.literal("state"), ...ENVELOPE, data: StatePayloadSchema }),
]);

/** @public */
export type SessionEvent = z.infer<typeof SessionEventSchema>;
/** @public */
export type SessionEventType = SessionEvent["type"];

// ─── Permissive type guard ───────────────────────────────────────────────────

/**
 * Permissive runtime guard ; true when `input` looks like a SessionEvent
 * (legacy dotted-lowercase OR canonical AG-UI form). Used by relay-client +
 * PWA + conformance suite so the same handler can accept events emitted in
 * either era.
 *
 * The guard checks only the envelope ; it does NOT validate the payload
 * shape against `SessionEventSchema`. For full validation, use
 * `SessionEventSchema.safeParse(input)` separately.
 *
 * @public @since 2.27.0
 */
export function looksLikeSessionEvent(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  if (typeof obj.id !== "string") return false;
  if (typeof obj.seq !== "number" || !Number.isFinite(obj.seq)) return false;
  if (typeof obj.ts !== "string") return false;
  if (typeof obj.data !== "object" || obj.data === null) return false;
  return isKnownEventType(obj.type);
}

// ─── Construction helper ─────────────────────────────────────────────────────

let monotonicSeq = 0;

/**
 * Build a well-formed SessionEvent envelope around a payload.
 *
 * `seq` is monotonic process-wide; `id` is unique. The event is NOT signed
 * here — `signing.ts` adds `sig` as a separate, optional step so the SDK
 * stays free of a hard crypto dependency.
 * @public
 */
export function makeEvent<T extends SessionEvent["type"]>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
): SessionEvent {
  return {
    type,
    id: `evt_${Date.now().toString(36)}_${monotonicSeq.toString(36)}`,
    seq: monotonicSeq++,
    ts: new Date().toISOString(),
    data,
  } as SessionEvent;
}

/** Distinct id source for ephemeral deltas ; kept off `monotonicSeq` on
 * purpose (see {@link makeEphemeralDelta}). */
let ephemeralDeltaId = 0;

/**
 * Build an EPHEMERAL streamed text delta (`TEXT_MESSAGE_CONTENT`) for the C2
 * streaming path (session-dans-la-poche). Unlike {@link makeEvent}, this does
 * NOT consume a `monotonicSeq` value : deltas carry a `seq` of 0 (a sentinel,
 * NOT a real position) because the hub filters them out of the ring backlog
 * (`remote/port.ts`). Keeping deltas off the durable counter keeps the durable
 * event `seq` stream gap-free, so `backlogOldestSeq()` truncation detection
 * stays exact ; a delta's `seq` never participates in backlog or `?since=`
 * replay. The consumer treats a delta as render-only : it appends `data.text`
 * to a live cursor and never dedups, sorts, or gap-checks on the sentinel `seq`
 * (a seq-ordered insert MUST treat 0 as append-always, never a sort position nor
 * a dedup key ; a generic seq-dedup that maps 0 to "already seen" silently drops
 * a second delta and mis-orders it, a real consumer-side trap). The durable
 * record for the message remains `TEXT_MESSAGE_END`.
 *
 * The emit boundary in the hub canonicalises `"assistant.delta"` to
 * `"TEXT_MESSAGE_CONTENT"` (`toCanonicalEventType`), same as every other loop
 * event ; the dotted name here mirrors the loop's existing emit style.
 */
export function makeEphemeralDelta(text: string): SessionEvent {
  return {
    type: "assistant.delta",
    id: `evt_delta_${(ephemeralDeltaId++).toString(36)}`,
    seq: 0,
    ts: new Date().toISOString(),
    data: { text },
  } as SessionEvent;
}

/** Reset the monotonic sequence — test-only. */
export function __resetEventSeq(): void {
  monotonicSeq = 0;
  ephemeralDeltaId = 0;
}
