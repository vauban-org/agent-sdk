/**
 * OODA HITL gate — sprint-525:quick-2.
 *
 * Blocks the OODA `act` phase until a human approves (or rejects) the
 * pending decision. In `dry-run` execution mode the gate is a no-op
 * (auto-approve) so simulation runs do not require human attention.
 *
 * Live mode persists a row in `hitl_approvals` (status=`pending`) and
 * polls every 2s until a row reaches `approved` / `rejected` or until
 * the configured timeout elapses. On timeout, the `onTimeout` policy
 * decides the verdict.
 *
 * The DbClient interface is the same minimal subset used elsewhere in
 * the SDK (compatible with pg.Pool, pg.Client, and test mocks).
 *
 * @public
 */

import type { DbClient } from "../../tracking/agent-run-tracker.js";
import type { ExecutionMode } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type HITLOnTimeoutPolicy = "reject" | "approve" | "continue-skip";

export interface HITLGateOptions {
  /** Hard wait before applying onTimeout policy. Default: 5 minutes. */
  timeoutMs?: number;
  /** Verdict on timeout. Default: "reject". */
  onTimeout?: HITLOnTimeoutPolicy;
  /** Polling interval for live mode. Default: 2000 ms. */
  pollIntervalMs?: number;
}

export interface HITLGateArgs {
  runId: string;
  agentId: string;
  decisionPayload: Record<string, unknown>;
  executionMode: ExecutionMode;
}

export interface HITLGateVerdict {
  approved: boolean;
  rationale?: string;
  resolvedBy?: string;
  timedOut: boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_ON_TIMEOUT: HITLOnTimeoutPolicy = "reject";

// ─── Internal row shape ───────────────────────────────────────────────────────

interface HitlRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  rationale: string | null;
  resolved_by: string | null;
}

/**
 * Wait for a HITL approval before allowing the agent to commit the act
 * phase. In `dry-run` mode this short-circuits to `approved=true` so
 * simulation runs are non-blocking.
 *
 * Live mode contract:
 *   1. INSERT a row in `hitl_approvals` with status='pending'
 *   2. Poll every `pollIntervalMs` (default 2s) for status change
 *   3. Resolve when status transitions to approved/rejected
 *   4. On timeout: apply onTimeout policy (default 'reject')
 *
 * The polling interval is intentionally generous (2s) to avoid DB
 * pressure under sustained workloads — UX latency is bounded by the
 * human approval round-trip anyway.
 */
export async function waitForHITLApproval(
  db: DbClient,
  args: HITLGateArgs,
  options: HITLGateOptions = {},
): Promise<HITLGateVerdict> {
  // Auto-approve in dry-run regardless of DB state.
  if (args.executionMode === "dry-run") {
    return { approved: true, timedOut: false, resolvedBy: "dry-run-auto" };
  }

  if (args.executionMode !== "live") {
    throw new Error(`[ooda/hitl-gate] invalid executionMode: ${String(args.executionMode)}`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onTimeout = options.onTimeout ?? DEFAULT_ON_TIMEOUT;

  // 1. INSERT pending row (returns id).
  const insert = await db.query<{ id: string }>(
    `INSERT INTO hitl_approvals
       (run_id, agent_id, decision_payload, status, requested_at)
     VALUES
       ($1, $2, $3::jsonb, 'pending', now())
     RETURNING id`,
    [args.runId, args.agentId, JSON.stringify(args.decisionPayload)],
  );

  const row = insert.rows[0];
  if (!row) {
    throw new Error("[ooda/hitl-gate] insert returned no row");
  }
  const hitlId = row.id;

  // 2. Poll loop with hard deadline.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const sleepMs = Math.min(pollIntervalMs, Math.max(remaining, 0));
    await sleep(sleepMs);

    const poll = await db.query<HitlRow>(
      `SELECT id, status, rationale, resolved_by
         FROM hitl_approvals
        WHERE id = $1`,
      [hitlId],
    );
    const current = poll.rows[0];
    if (!current) {
      // Row vanished (cancellation) — treat as rejected.
      return { approved: false, timedOut: false, rationale: "row-missing" };
    }
    if (current.status === "approved") {
      return {
        approved: true,
        timedOut: false,
        rationale: current.rationale ?? undefined,
        resolvedBy: current.resolved_by ?? undefined,
      };
    }
    if (current.status === "rejected") {
      return {
        approved: false,
        timedOut: false,
        rationale: current.rationale ?? undefined,
        resolvedBy: current.resolved_by ?? undefined,
      };
    }
  }

  // 3. Timeout reached — apply policy.
  const approvedOnTimeout = onTimeout === "approve" || onTimeout === "continue-skip";
  return {
    approved: approvedOnTimeout,
    timedOut: true,
    rationale: `timeout:${onTimeout}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });
}
