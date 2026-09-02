/**
 * HITL approval-channel contract + in-memory store.
 *
 * Transport-agnostic: concrete transports live in concrete channel
 * implementations (email, telegram, etc.).
 */

import { riskScore, type RiskVector } from "../tools/types.js";

/**
 * Risk metadata carried alongside an `ApprovalRequest` for the HITL ceremony
 * display (phone/PWA). Derived from a tool's `RiskVector` (tools/types.ts) ;
 * display-only — basis: declared. The `dangerous` flag / approval predicate
 * remain the sole authority on whether approval is required at all ; this
 * field never feeds a gating decision.
 * @public
 * @since sprint-1067 (risk-vector-wire)
 */
export interface ApprovalRisk
  extends Pick<
    RiskVector,
    "reversibility" | "blastRadius" | "dataSensitivity" | "externalSideEffect"
  > {
  /** Weighted aggregate score in [0, 1] ; `riskScore(vector)`. */
  score: number;
}

/**
 * Derive an `ApprovalRisk` display record from a tool's `RiskVector`.
 * @public
 * @since sprint-1067 (risk-vector-wire)
 */
export function toApprovalRisk(v: RiskVector): ApprovalRisk {
  return {
    score: riskScore(v),
    reversibility: v.reversibility,
    blastRadius: v.blastRadius,
    dataSensitivity: v.dataSensitivity,
    externalSideEffect: v.externalSideEffect,
  };
}

/**
 * Metadata supplied when an agent requests human authorisation.
 * @public
 */
export interface ApprovalRequest {
  /** Stable agent identifier (e.g. `market-radar`). */
  agentId: string;
  /** Short action description shown to the approver (e.g. `anchor_seal`). */
  action: string;
  /** Extra context (tool name, arguments, rationale). */
  context: string;
  /** Hard wait timeout in milliseconds before falling back to deny. */
  timeoutMs: number;
  /**
   * Optional risk metadata for the tool triggering this request, derived
   * from its `RiskVector` when present via `toApprovalRisk()`. Additive ;
   * absent when the tool declares no `RiskVector` (a bare `dangerous: true`
   * still gates approval on its own).
   * @since sprint-1067 (risk-vector-wire)
   */
  risk?: ApprovalRisk;
}

/**
 * Verdict returned by a human approver.
 * @public
 */
export interface Approval {
  approved: boolean;
  rationale?: string;
  /** Identifier of the approver (e.g. Slack user id or email). */
  by: string;
  /** ISO 8601 timestamp of the verdict. */
  at: string;
  /**
   * Optional standing-grant scope the approver requested alongside this one
   * verdict (e.g. a Telegram `/approve always` reply). Additive, optional —
   * channels that never set it are unaffected. A caller that wants to turn a
   * single verdict into a remembered grant (preste's grant-aware approval
   * decorator) reads this field; it carries no meaning on its own.
   * @since uplift-C (sprint-939)
   */
  scope?: "session" | "always";
  /**
   * True when this negative verdict is a fail-closed TIMEOUT (no human answered
   * within the wait window), as opposed to an EXPLICIT deny by an approver.
   * Additive, optional ; a channel that never sets it is unaffected. A caller
   * that must report the two honestly apart (the child-approval rail's
   * `approval_denied` vs `approval_timeout` stop reasons) reads this field
   * instead of coupling to a channel-internal magic `by` string. Only
   * meaningful when `approved` is false ; ignored otherwise.
   * @since sprint-1009 (child-approval-channel)
   */
  timedOut?: boolean;
}

/**
 * Transport-agnostic HITL channel. Concrete impls (Email, Telegram, ...) must
 * satisfy `send → poll → (resolve ∨ cancel)` semantics.
 * @public
 */
export interface ApprovalChannel {
  /** Dispatch an approval request and return an opaque request id. */
  send(req: ApprovalRequest): Promise<string>;
  /** Poll for a verdict. Returns null while the request is still pending. */
  poll(id: string): Promise<Approval | null>;
  /** Cancel a pending request (e.g. on agent timeout or cancellation). */
  cancel(id: string): Promise<void>;
}

// ─── Store contract ────────────────────────────────────────────────────────

/** @public */
export type ApprovalStatus = "pending" | "resolved" | "cancelled" | "timedout";

/** @public */
export interface PendingApproval {
  id: string;
  req: ApprovalRequest;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  verdict?: Approval;
}

/**
 * Pluggable storage for pending approvals. Channels use it to persist state
 * between `send()` and callback resolution (e.g. HTTP click from email).
 *
 * `resolve` uses optimistic CAS: returns `false` if entry is missing or not
 * pending (race-safe — first caller wins).
 * @public
 */
export interface ApprovalStore {
  create(entry: PendingApproval): Promise<void>;
  get(id: string): Promise<PendingApproval | null>;
  /** First writer wins. Returns true on transition, false on no-op. */
  resolve(id: string, verdict: Approval): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  /** Mark overdue pending entries as `timedout`. Returns count affected. */
  expireOverdue(now?: number): Promise<number>;
}

/**
 * Process-local in-memory store. Suitable for CI tests and single-instance
 * deployments. Multi-instance prod deployments should plug a Redis/Postgres
 * impl behind this interface.
 * @public
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly entries = new Map<string, PendingApproval>();

  async create(entry: PendingApproval): Promise<void> {
    if (this.entries.has(entry.id)) {
      throw new Error(`approval: duplicate id ${entry.id}`);
    }
    this.entries.set(entry.id, { ...entry });
  }

  async get(id: string): Promise<PendingApproval | null> {
    const e = this.entries.get(id);
    return e ? { ...e } : null;
  }

  async resolve(id: string, verdict: Approval): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.status !== "pending") return false;
    e.status = "resolved";
    e.verdict = verdict;
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || e.status !== "pending") return false;
    e.status = "cancelled";
    return true;
  }

  async expireOverdue(now = Date.now()): Promise<number> {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.status === "pending" && now > e.expiresAt) {
        e.status = "timedout";
        n += 1;
      }
    }
    return n;
  }

  /**
   * Enumerate all entries. Not part of the `ApprovalStore` contract — used
   * by dashboard routes to render the HITL queue and history.
   * Multi-instance prod deployments must replace this with a paginated
   * backing query (Redis ZRANGE, Postgres, ...).
   */
  async listAll(): Promise<readonly PendingApproval[]> {
    return Array.from(this.entries.values(), (e) => ({ ...e }));
  }
}
