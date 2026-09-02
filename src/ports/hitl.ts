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
