/**
 * HITLPort — Human-In-The-Loop state machine port.
 *
 * Plan v6 §1.7 + §3.4: State lives in Postgres (CC), NOT in MessagingChannel.
 * Channels = transports; state = HITLPort + Postgres.
 *
 * State machine (legal transitions):
 *   pending → approved | rejected | expired   ✅
 *   approved | rejected → executed             ✅
 *   expired → *                                ❌ terminal
 *   approved → rejected (or inverse)           ❌ forbidden
 *
 * @public
 */

// ─── State machine ───────────────────────────────────────────────────────────

export type HITLState = "pending" | "approved" | "rejected" | "expired" | "executed";

// Legal transition table: from → set of valid to states
const LEGAL_TRANSITIONS: Record<HITLState, ReadonlySet<HITLState>> = {
  pending: new Set(["approved", "rejected", "expired"]),
  approved: new Set(["executed"]),
  rejected: new Set(["executed"]),
  expired: new Set(),
  executed: new Set(),
};

/**
 * Thrown when a state-machine transition is attempted that violates the HITL
 * state diagram (e.g. expired → approved, approved → rejected).
 * @public
 */
export class InvalidStateTransitionError extends Error {
  readonly from: HITLState;
  readonly to: HITLState;

  constructor(from: HITLState, to: HITLState) {
    super(`Invalid HITL state transition: ${from} → ${to}`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a HITL request id is not found in the state store.
 * @public
 */
export class HITLNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`HITL request not found: ${id}`);
    this.name = "HITLNotFoundError";
    this.id = id;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validate that a transition from → to is legal per the HITL state machine.
 * Throws `InvalidStateTransitionError` if illegal.
 * @public
 */
export function validateTransition(from: HITLState, to: HITLState): void {
  if (!LEGAL_TRANSITIONS[from].has(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

// ─── Domain types ────────────────────────────────────────────────────────────

/** @public */
export interface HITLRequest {
  id: string;
  agentSource: string;
  question: string;
  context: Record<string, unknown>;
  options: string[];
  /** ISO 8601 deadline */
  deadline: string;
  channel: "telegram" | "slack" | "discord";
  tenantId?: string;
}

/**
 * Structured, non-repudiable approver identity as encoded into the `by`
 * parameter of {@link HITLPort.resolve}: the string `"<channel>:<id>"`
 * (e.g. `"slack:U0123ABC"`, `"telegram:123456789"`).
 *
 * `id` MUST be the channel's stable, opaque/numeric user id — never a
 * display name or `@username` alone, since those are mutable and are not
 * suitable evidence for a non-repudiation audit trail (AI Act art. 12 & 14).
 *
 * This type documents the shape callers should build with
 * {@link formatApprover} / read back with {@link parseApprover}. It is not
 * threaded through `HITLPort.resolve()`'s return type (`Promise<void>`)
 * because doing so would be a breaking signature change gated by
 * CONTRACT.md's breaking-change policy — `by: string` stays the wire
 * contract; this is additive documentation only.
 *
 * @public
 */
export interface HITLApprover {
  channel: HITLRequest["channel"];
  id: string;
  username?: string;
  /** ISO 8601 timestamp of the decision. */
  at: string;
}

/**
 * Build the structured `by` string HITL channel adapters must pass to
 * {@link HITLPort.resolve}. See {@link HITLApprover}.
 * @public
 */
export function formatApprover(channel: HITLRequest["channel"], id: string): string {
  return `${channel}:${id}`;
}

/**
 * Parse a structured `by` string produced by {@link formatApprover} back
 * into its channel + id parts. Returns null if `by` is not in the
 * `"<channel>:<id>"` shape (e.g. a legacy unstructured value).
 * @public
 */
export function parseApprover(by: string): { channel: string; id: string } | null {
  const idx = by.indexOf(":");
  if (idx <= 0 || idx === by.length - 1) return null;
  return { channel: by.slice(0, idx), id: by.slice(idx + 1) };
}

// ─── Port interface ──────────────────────────────────────────────────────────

/**
 * HITLPort — stateful HITL lifecycle contract.
 *
 * Implementations: MemoryHITLStateStore (tests/dev), PostgresHITLStateStore (prod).
 * Callers (MessagingChannel, pipeline runner) depend on this port — never on DB directly.
 * @public
 */
export interface HITLPort {
  /**
   * Record a new HITL request. Returns the approvalId (= req.id).
   * State is set to 'pending'.
   */
  request(req: HITLRequest): Promise<string>;

  /** Fetch the current state of a HITL request. Throws HITLNotFoundError if absent. */
  getState(id: string): Promise<HITLState>;

  /**
   * Poll until the request leaves 'pending', or until timeoutMs expires.
   * Returns the current state (which may still be 'pending' if timeout fires).
   * Defaults to no timeout (polls until resolved/expired).
   */
  await(id: string, timeoutMs?: number): Promise<HITLState>;

  /**
   * Record a human decision (approved | rejected) on a pending request.
   *
   * `by` MUST be a structured individual approver identity of the form
   * `"<channel>:<id>"` (see {@link HITLApprover} / {@link formatApprover}),
   * e.g. `"slack:U0123ABC"` or `"telegram:123456789"` — the channel's
   * stable id of the human who decided, never the bare channel name and
   * never a display name/username alone. Channel adapters must fail
   * closed (never call `resolve`) when the inbound payload does not carry
   * that id, so the audit trail never records a channel constant in place
   * of an individual (AI Act art. 12 & 14 non-repudiation).
   *
   * Throws HITLNotFoundError if absent.
   * Throws InvalidStateTransitionError if current state is not 'pending'.
   */
  resolve(id: string, decision: "approved" | "rejected", by: string): Promise<void>;

  /**
   * Mark a pending request as expired (called by background worker).
   * Throws HITLNotFoundError if absent.
   * Throws InvalidStateTransitionError if not pending.
   */
  expire(id: string): Promise<void>;
}

// ─── Background expiry helper ────────────────────────────────────────────────

/**
 * Start a background interval that expires overdue pending requests.
 *
 * @param store    HITLPort implementation (must support internal expiry logic)
 * @param intervalMs  Polling interval (default 60 000 ms)
 * @returns NodeJS.Timeout — call clearInterval() to stop the job
 * @public
 */
export function runExpireJob(
  store: HITLPort & { _expireOverdue?: () => Promise<void> },
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(async () => {
    if (typeof store._expireOverdue === "function") {
      await store._expireOverdue().catch(() => {
        // Background job: swallow errors to prevent process crash
      });
    }
  }, intervalMs);
}
