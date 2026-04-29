/**
 * OODA run_step persistence helpers — sprint-525:quick-2.
 *
 * Mirrors the pattern from src/router/execution-pipeline.ts (sprint-521):
 *   insertRunStep  → INSERT row with status='pending', returns stepId
 *   completeRunStep → UPDATE status='done' + leaf_hash_poseidon (Poseidon JCS)
 *   errorRunStep    → UPDATE status='error' + error_message
 *
 * Decoupled from the command-center monolith: imports computeLeafHash
 * via the SDK's own poseidon module (shipped sprint-521:quick-13).
 *
 * The DbClient interface is the minimal pg.Pool/pg.Client subset already
 * used by `agent-run-tracker.ts` — keeps the SDK pg-free at install time.
 *
 * @public
 */

import { computeLeafHash } from "../../proof/poseidon.js";
import type { DbClient } from "../../tracking/agent-run-tracker.js";
import type { OODAPhaseKind } from "./types.js";

export interface InsertRunStepInput {
  type: OODAPhaseKind;
  /** Human-readable phase tag (e.g. "observe", "orient", "decide", "act"). */
  phase: string;
  stepIndex: number;
  payload?: Record<string, unknown>;
  parentStepId?: string;
}

/**
 * Insert a `run_step` row in `pending` state and return the freshly
 * minted UUID. Caller is responsible for finishing it via
 * `completeRunStep` / `errorRunStep`.
 */
export async function insertRunStep(
  db: DbClient,
  runId: string,
  input: InsertRunStepInput,
): Promise<{ stepId: string }> {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("[ooda] insertRunStep: runId must be a non-empty string");
  }
  if (!Number.isInteger(input.stepIndex) || (input.stepIndex as number) < 0) {
    throw new Error("[ooda] insertRunStep: stepIndex must be a non-negative integer");
  }

  const payloadJson = JSON.stringify(input.payload ?? {});

  const res = await db.query<{ id: string }>(
    `INSERT INTO run_step
       (run_id, step_index, parent_step_id, type, phase, status, started_at, payload)
     VALUES
       ($1, $2, $3, $4, $5, 'pending', now(), $6::jsonb)
     RETURNING id`,
    [runId, input.stepIndex, input.parentStepId ?? null, input.type, input.phase, payloadJson],
  );

  const row = res.rows[0];
  if (!row) {
    throw new Error("[ooda] insertRunStep: insert returned no row");
  }
  return { stepId: row.id };
}

/**
 * Mark a `run_step` row as `done`, attach its final payload, and write
 * the Poseidon leaf hash for cryptographic accountability.
 *
 * The leaf hash is computed from the FINAL payload (not the pending one),
 * keeping the on-disk hash in sync with the canonical state at completion.
 */
export async function completeRunStep(
  db: DbClient,
  stepId: string,
  payload: Record<string, unknown>,
): Promise<{ leafHash: string }> {
  if (typeof stepId !== "string" || stepId.length === 0) {
    throw new Error("[ooda] completeRunStep: stepId must be a non-empty string");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("[ooda] completeRunStep: payload must be a plain object");
  }

  const leafHash = computeLeafHash(payload);

  await db.query(
    `UPDATE run_step
        SET status = 'done',
            finished_at = now(),
            payload = $2::jsonb,
            leaf_hash_poseidon = $3
      WHERE id = $1`,
    [stepId, JSON.stringify(payload), leafHash],
  );

  return { leafHash };
}

/**
 * Mark a `run_step` row as `error` with the given error message.
 * Idempotent w.r.t. multiple error calls — last-write-wins on the message.
 */
export async function errorRunStep(db: DbClient, stepId: string, error: Error): Promise<void> {
  if (typeof stepId !== "string" || stepId.length === 0) {
    throw new Error("[ooda] errorRunStep: stepId must be a non-empty string");
  }
  const message = error instanceof Error ? error.message : String(error);

  await db.query(
    `UPDATE run_step
        SET status = 'error',
            finished_at = now(),
            error_message = $2
      WHERE id = $1`,
    [stepId, message],
  );
}
