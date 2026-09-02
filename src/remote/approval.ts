/**
 * remote/approval — RemoteApprovalChannel: HITL routed to a remote client.
 *
 * Implements the SDK's `ApprovalChannel` port. When the agent loop needs
 * approval for a dangerous tool, this channel:
 *   1. emits a `hitl.request` SessionEvent — the remote client (phone) sees it;
 *   2. parks the request until the client calls `resolve()` (wired by a
 *      transport to e.g. `POST /remote/hitl/:id/approve`);
 *   3. on `timeoutMs` with no verdict, applies the fail-closed timeout policy.
 *
 * It emits `hitl.resolved` on every verdict so the remote client's view stays
 * consistent. This is the HITL half of remote-control — the founder wants to
 * "approve commands" from the phone.
 *
 * @public @since 2.11.0 — preste remote-control T1
 */

import { randomUUID } from "node:crypto";
import type { Approval, ApprovalChannel, ApprovalRequest } from "../hitl/approval-channel.js";
import { makeEvent } from "./events.js";
import type { SessionEventSink } from "./sink.js";

/** What to do when a HITL request times out with no remote verdict. */
export type RemoteTimeoutPolicy = "approve" | "reject";

export interface RemoteApprovalOptions {
  /** Sink the hitl.request / hitl.resolved events are emitted to. */
  sink: SessionEventSink;
  /** Default wait before the timeout policy fires. Default 120_000 ms. */
  timeoutMs?: number;
  /** Verdict applied on timeout. Default "reject" — fail closed. */
  onTimeout?: RemoteTimeoutPolicy;
}

interface PendingApproval {
  id: string;
  req: ApprovalRequest;
  status: "pending" | "resolved";
  verdict?: Approval;
  timer?: ReturnType<typeof setTimeout>;
}

/** A single resolved HITL decision — the audit record of a verdict. */
export interface RemoteHitlRecord {
  action: string;
  approved: boolean;
  by: string;
  at: string;
}

/** @public */
export interface RemoteApprovalChannel extends ApprovalChannel {
  /**
   * Apply a verdict — wired by the transport to the approve/reject route.
   * `scope` is additive (uplift-C, sprint-939): a transport that lets the
   * approver say "always" (e.g. Telegram `/approve always`) passes it
   * through here and it lands on the stored verdict as `Approval.scope`,
   * for a grant-aware caller to turn into a standing grant. Omitted by
   * every existing caller — zero behavior change.
   */
  resolve(
    id: string,
    approved: boolean,
    by: string,
    note?: string,
    scope?: "session" | "always",
  ): boolean;
  /** Requests currently awaiting a verdict. `agentId` is the requesting
   * agent identifier (for a teammate ask, the recipient session's runId), so
   * an answering surface can attribute a pending request to a session without
   * a second store. */
  pending(): Array<{ id: string; agentId: string; action: string; context: string }>;
  /** Every resolved verdict — the human-oversight audit trail. */
  history(): RemoteHitlRecord[];
  /** Clear pending timers — call on session teardown. */
  dispose(): void;
}

/**
 * Create a RemoteApprovalChannel bound to a SessionEventSink.
 * @public
 */
export function createRemoteApprovalChannel(opts: RemoteApprovalOptions): RemoteApprovalChannel {
  const defaultTimeout = opts.timeoutMs ?? 120_000;
  const onTimeout: RemoteTimeoutPolicy = opts.onTimeout ?? "reject";
  const queue = new Map<string, PendingApproval>();

  function settle(
    id: string,
    approved: boolean,
    by: string,
    note: string,
    scope?: "session" | "always",
    timedOut?: boolean,
  ): boolean {
    const e = queue.get(id);
    if (!e || e.status !== "pending") return false;
    if (e.timer) clearTimeout(e.timer);
    e.status = "resolved";
    e.verdict = {
      approved,
      by,
      rationale: note,
      at: new Date().toISOString(),
      ...(scope ? { scope } : {}),
      ...(timedOut ? { timedOut } : {}),
    };
    opts.sink.emit(makeEvent("hitl.resolved", { requestId: id, approved, by }));
    return true;
  }

  return {
    async send(req: ApprovalRequest): Promise<string> {
      const id = randomUUID();
      const timeoutMs = req.timeoutMs > 0 ? req.timeoutMs : defaultTimeout;
      const entry: PendingApproval = { id, req, status: "pending" };
      entry.timer = setTimeout(() => {
        settle(
          id,
          onTimeout === "approve",
          "timeout-policy",
          `auto-${onTimeout} after ${timeoutMs}ms`,
          undefined,
          // Mark the fail-closed timeout honestly so a wrapping child-approval
          // rail reports `approval_timeout` rather than `approval_denied`.
          onTimeout === "reject",
        );
      }, timeoutMs);
      entry.timer.unref?.();
      queue.set(id, entry);
      opts.sink.emit(
        makeEvent("hitl.request", {
          requestId: id,
          action: req.action,
          context: req.context,
          expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
          ...(req.risk ? { risk: req.risk } : {}),
        }),
      );
      return id;
    },

    async poll(id: string): Promise<Approval | null> {
      const e = queue.get(id);
      return e && e.status === "resolved" && e.verdict ? e.verdict : null;
    },

    async cancel(id: string): Promise<void> {
      const e = queue.get(id);
      if (e?.timer) clearTimeout(e.timer);
      if (e && e.status === "pending") {
        e.status = "resolved";
        e.verdict = {
          approved: false,
          by: "cancelled",
          rationale: "request cancelled",
          at: new Date().toISOString(),
        };
        opts.sink.emit(
          makeEvent("hitl.resolved", {
            requestId: id,
            approved: false,
            by: "cancelled",
          }),
        );
      }
    },

    resolve(
      id: string,
      approved: boolean,
      by: string,
      note = "",
      scope?: "session" | "always",
    ): boolean {
      return settle(id, approved, by, note, scope);
    },

    pending() {
      return [...queue.values()]
        .filter((e) => e.status === "pending")
        .map((e) => ({
          id: e.id,
          agentId: e.req.agentId,
          action: e.req.action,
          context: e.req.context,
        }));
    },

    history(): RemoteHitlRecord[] {
      const out: RemoteHitlRecord[] = [];
      for (const e of queue.values()) {
        if (e.status === "resolved" && e.verdict) {
          out.push({
            action: e.req.action,
            approved: e.verdict.approved,
            by: e.verdict.by,
            at: e.verdict.at,
          });
        }
      }
      return out;
    },

    dispose(): void {
      for (const e of queue.values()) {
        if (e.timer) clearTimeout(e.timer);
      }
    },
  };
}
