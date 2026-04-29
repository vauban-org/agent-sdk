/**
 * OODA HITL audit-log helper — sprint-525:quick-2.
 *
 * Records a human's verdict on a HITL approval request. This is the
 * "resolve" side of the gate persisted by `waitForHITLApproval`: the
 * gate INSERTs a `pending` row, this helper UPDATEs it to the final
 * decision so the polling loop can observe the transition.
 *
 * The dashboard or operator UI calls this exactly once per request.
 * The UPDATE is gated on `status='pending'` so a double-resolve from
 * concurrent UIs is a no-op for the second writer.
 *
 * @public
 */

import type { DbClient } from "../../tracking/agent-run-tracker.js";

export type HITLDecision = "approved" | "rejected";

/**
 * Record a HITL verdict in `hitl_approvals`. Returns silently — the
 * polling gate observes the row transition on its next tick.
 *
 * Concurrent calls: only the first one transitions the row (status
 * filter on UPDATE). Subsequent callers find no `pending` row and the
 * UPDATE simply affects 0 rows.
 */
export async function recordHITLDecision(
  db: DbClient,
  hitlId: string,
  decision: HITLDecision,
  resolverUserId: string,
  rationale?: string,
): Promise<void> {
  if (typeof hitlId !== "string" || hitlId.length === 0) {
    throw new Error("[ooda/audit-log] hitlId must be a non-empty string");
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(
      `[ooda/audit-log] decision must be 'approved' | 'rejected'. Got: ${String(decision)}`,
    );
  }
  if (typeof resolverUserId !== "string" || resolverUserId.length === 0) {
    throw new Error("[ooda/audit-log] resolverUserId must be a non-empty string");
  }

  await db.query(
    `UPDATE hitl_approvals
        SET status = $2,
            resolved_by = $3,
            rationale = $4,
            resolved_at = now()
      WHERE id = $1
        AND status = 'pending'`,
    [hitlId, decision, resolverUserId, rationale ?? null],
  );
}
