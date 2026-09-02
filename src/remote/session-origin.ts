/**
 * remote/session-origin ; the SessionOrigin seam (SP-C.1, ADR-ECO-126 pillar 4).
 *
 * SP-A/B made the remote surface origin-blind at the DISCOVERY layer : a phone
 * sees "a session in your fleet" via the fleet-cert-signed announce, whoever
 * started it. What was missing is the ORIGIN-CONTROL seam : a phone could only
 * ATTACH to a session a human had already started at a terminal, never START
 * one. This port is that seam.
 *
 * An origin turns a start request into a running, fleet-announced session and
 * returns its identity. The remote surface calls it through the governed `start`
 * control verb (`delegation/teammate-message.ts`) ; the controller never learns
 * the substrate, only that "a new session appeared in your fleet".
 *
 * SUBSTRATE-AGNOSTIC BY CONSTRUCTION. This module is types + a guard + an error
 * ; it holds no substrate. The implementations live with their substrate (the
 * CLI's `session-origin-local.ts` over the daemon ; the pod's over GitOps at
 * SP-C.2), because the SDK must never import preste. That is what makes the pod
 * a plug-in rather than a rewrite : it implements this interface and every
 * caller above it is unchanged.
 *
 * SPOTLIGHTING. A {@link SessionStartRequest} is `<external_data>` : `work.task`
 * and `work.repo` come from a remote controller and are DATA an origin hands to
 * its substrate, NEVER instructions the host interprets, and never echoed into
 * an outcome field or a log line.
 *
 * @module remote/session-origin
 * @public @experimental @since 3.7.0 ; SP-C.1 session-origin seam
 */

/**
 * Where a session comes from. The remote surface stays origin-blind ; this kind
 * is the ONLY place the substrate is named.
 *
 * - `local` ; a session on THIS install. Note the START-vs-ATTACH asymmetry
 *   (see {@link SessionOrigin.start}) : an interactive `preste chat` is the
 *   local origin a human attaches to, but a phone-triggered start cannot own a
 *   TTY, so a local START is necessarily headless (the CLI implementation rides
 *   the daemon, this host's real session substrate).
 * - `daemon` ; reserved for a start whose semantics are daemon-SPECIFIC rather
 *   than merely daemon-hosted. Not implemented (SP-C.1 wires `local` only).
 * - `gateway` ; the always-on service front (`preste gateway`). Not implemented.
 * - `pod` ; a sovereign K8s pod via GitOps single-writer (ADR-ECO-072), booting
 *   preste as the orchestrator on a repo. T4, deferred to SP-C.2.
 * @public @experimental
 */
export type SessionOriginKind = "local" | "daemon" | "gateway" | "pod";

/** Every designed origin kind ; for validating a wire-received string.
 * @public @experimental */
export const ALL_SESSION_ORIGIN_KINDS: readonly SessionOriginKind[] = [
  "local",
  "daemon",
  "gateway",
  "pod",
];

/** Runtime guard for an origin kind off the wire (untrusted input). Fail-closed
 * : an unknown substrate name is not an origin. @public @experimental */
export function isSessionOriginKind(v: string): v is SessionOriginKind {
  return (ALL_SESSION_ORIGIN_KINDS as readonly string[]).includes(v);
}

/**
 * The work a started session performs. Every field is opaque `<external_data>`
 * supplied by the controller : an origin passes it to its substrate as DATA and
 * never interprets it as an instruction.
 * @public @experimental
 */
export interface SessionStartWork {
  /** The prompt/task the session boots on. Opaque `<external_data>`. */
  readonly task: string;
  /** Stable operator-chosen session name, so the started session is addressable
   * by name rather than by a runId that changes on every start. */
  readonly name?: string;
  /** A repo ref, for an origin that clones one (the pod, SP-C.2). Opaque
   * `<external_data>` : a URL is data, never a host instruction. Ignored by an
   * origin whose substrate has no repo (the local origin). */
  readonly repo?: string;
}

/**
 * Who authorized this start, and the capability the started session is meant to
 * run under. The authorization DECISION is made ABOVE the origin (the governed
 * `start` verb's boundary gate) ; this record is what that decision resolved to.
 * @public @experimental
 */
export interface SessionStartGrant {
  /** The initiating principal, for the dual-identity binding
   * (nhi-agentic-iam) : the started session's work traces back to the human who
   * authorized it. Production shape : `controller:<installId>`. */
  readonly by: string;
  /** The authorized tool capability. An origin MUST NOT claim to enforce this
   * when its substrate cannot ; it reports the truth in
   * {@link StartedSession.toolsEnforced} instead of silently overclaiming. */
  readonly tools?: readonly string[];
}

/** A request to start a session. `<external_data>` ; see the module doc.
 * @public @experimental */
export interface SessionStartRequest {
  /** The origin asked for. An origin fails closed on a kind that is not its
   * own rather than silently starting a session of a different kind. */
  readonly kind: SessionOriginKind;
  readonly work: SessionStartWork;
  readonly grant: SessionStartGrant;
}

/** The identity of a session an origin started. @public @experimental */
export interface StartedSession {
  /** The routing key every remote verb addresses (announce + `/teammate/send`). */
  readonly runId: string;
  /** The origin that produced it. */
  readonly kind: SessionOriginKind;
  /** True when the session was started in a mode that makes it fleet-announced,
   * hence driveable from a controller exactly like any other session. False
   * means it runs but is NOT remotely reachable. */
  readonly announced: boolean;
  /**
   * Whether {@link SessionStartGrant.tools} was actually applied to the started
   * session's tool surface. HONESTY INVARIANT : an origin whose substrate takes
   * no tool allowlist reports `false` rather than implying an attenuation it did
   * not perform. `false` does NOT mean ungoverned ; the boundary gate that
   * authorized the start still ran, and the session is still bounded by its
   * host's own configuration. It means only : this grant's tool list was not the
   * thing that bounded it.
   */
  readonly toolsEnforced: boolean;
  /** The stable name it is addressable by, when one was assigned. */
  readonly name?: string;
  /** The install hosting it, when the origin knows it. */
  readonly installId?: string;
}

/** A reference to an existing session. @public @experimental */
export interface SessionRef {
  readonly runId: string;
  readonly installId?: string;
}

/** The identity of a session an origin resolved. @public @experimental */
export interface AttachedSession {
  readonly runId: string;
  readonly kind: SessionOriginKind;
  /** True when the session is currently fleet-announced (driveable). */
  readonly announced: boolean;
  readonly name?: string;
}

/**
 * Thrown when an origin cannot satisfy a request : a wrong kind, an unavailable
 * substrate, a denied start, an unknown session. Fail-closed : an origin throws
 * rather than return a half-started session. Carries the `kind` and a STRUCTURAL
 * `reason` ; it NEVER embeds a task/repo VALUE (that is `<external_data>`).
 * @public @experimental
 */
export class SessionOriginError extends Error {
  constructor(
    public readonly kind: string,
    public readonly reason: string,
  ) {
    super(`SessionOriginError [${kind}]: ${reason}`);
    this.name = "SessionOriginError";
  }
}

/**
 * A session substrate behind one interface : produce a session, or resolve one
 * that exists.
 * @public @experimental
 */
export interface SessionOrigin {
  /** The substrate this origin speaks for. */
  readonly kind: SessionOriginKind;
  /**
   * Produce a running, fleet-announced session. The NEW capability SP-C.1 adds :
   * before it, a controller could only drive sessions a human had already
   * started. Throws {@link SessionOriginError} fail-closed.
   */
  start(req: SessionStartRequest): Promise<StartedSession>;
  /**
   * Resolve an existing session's identity. This is the layer SP-A/B already
   * drive, expressed through the port so an origin is one interface rather than
   * two half-abstractions. Throws {@link SessionOriginError} when no such
   * session exists.
   */
  attach(ref: SessionRef): Promise<AttachedSession>;
}
