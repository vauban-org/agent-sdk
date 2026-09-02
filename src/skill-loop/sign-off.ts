/**
 * src/skill-loop/sign-off.ts
 *
 * Article 14 human oversight mechanism for skill promotion.
 *
 * Invariants:
 *   - Audit trail: { approver_id, timestamp, decision, rationale, signed_hash }
 *   - signed_hash = SHA-256(candidateId + decision + rationale + isoTimestamp)
 *   - Escalation: approver unavailable >72h → auto-REJECTED (never auto-approved)
 *   - Multiple approvers possible; one sign-off is sufficient for promotion.
 *
 * @module skill-loop/sign-off
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @public */
export type SignOffDecision = "approved" | "rejected";

/** @public */
export interface SignOffRecord {
  /** Candidate ID this sign-off covers. */
  candidateId: string;
  /** Identifier of the human approver (e.g. user UUID or username). */
  approverId: string;
  /** ISO-8601 timestamp at which the decision was recorded. */
  timestamp: string;
  /** Human decision. */
  decision: SignOffDecision;
  /** Human-provided rationale (non-empty required). */
  rationale: string;
  /**
   * Integrity hash: SHA-256(candidateId + decision + rationale + timestamp).
   * Detects tampering in the audit trail.
   */
  signedHash: string;
}

/** @public */
export interface PendingRequest {
  candidateId: string;
  requestedAt: string;
  /** Approver ID if a specific approver is designated. Null = any approver. */
  approverId: string | null;
  /** Deadline beyond which the request is auto-rejected (72h from requestedAt). */
  deadlineAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function isoNow(overrideDate?: Date): string {
  return (overrideDate ?? new Date()).toISOString();
}

/** Compute the signed hash per the canonical formula. */
function computeSignedHash(
  candidateId: string,
  decision: SignOffDecision,
  rationale: string,
  timestamp: string,
): string {
  return sha256Hex(`${candidateId}${decision}${rationale}${timestamp}`);
}

// ---------------------------------------------------------------------------
// SignOffManager
// ---------------------------------------------------------------------------

/**
 * Manages pending approval requests and sign-off records.
 *
 * In production, records should be persisted to the DB. This implementation
 * is in-memory and suitable for tests and single-process environments.
 */
export class SignOffManager {
  private readonly records = new Map<string, SignOffRecord[]>();
  private readonly pending = new Map<string, PendingRequest>();

  /** 72-hour escalation deadline in milliseconds. */
  static readonly ESCALATION_DEADLINE_MS = 72 * 60 * 60 * 1_000;

  // ── Request ─────────────────────────────────────────────────────────────────

  /**
   * Create a pending approval request for a candidate.
   *
   * If a request already exists and is not expired, returns the existing one.
   */
  requestSignOff(
    candidateId: string,
    approverId: string | null = null,
    nowDate?: Date,
  ): PendingRequest {
    const existing = this.pending.get(candidateId);
    if (existing && !this.isExpired(existing, nowDate)) {
      return existing;
    }

    const requestedAt = isoNow(nowDate);
    const deadline = new Date(
      (nowDate ?? new Date()).getTime() + SignOffManager.ESCALATION_DEADLINE_MS,
    );

    const request: PendingRequest = {
      candidateId,
      requestedAt,
      approverId,
      deadlineAt: deadline.toISOString(),
    };
    this.pending.set(candidateId, request);
    return request;
  }

  // ── Approve / Reject ────────────────────────────────────────────────────────

  /**
   * Record a sign-off decision (approved or rejected).
   *
   * @throws If rationale is empty or candidateId is missing.
   */
  recordDecision(
    candidateId: string,
    approverId: string,
    decision: SignOffDecision,
    rationale: string,
    nowDate?: Date,
  ): SignOffRecord {
    if (!rationale || rationale.trim().length === 0) {
      throw new Error(
        `sign-off: rationale is required for decision "${decision}" on candidate "${candidateId}"`,
      );
    }

    const timestamp = isoNow(nowDate);
    const signedHash = computeSignedHash(candidateId, decision, rationale, timestamp);

    const record: SignOffRecord = {
      candidateId,
      approverId,
      timestamp,
      decision,
      rationale,
      signedHash,
    };

    const existing = this.records.get(candidateId) ?? [];
    existing.push(record);
    this.records.set(candidateId, existing);

    // Remove the pending request once a decision is recorded.
    this.pending.delete(candidateId);

    return record;
  }

  // ── Escalation ──────────────────────────────────────────────────────────────

  /**
   * Check all pending requests and auto-reject any that have exceeded the 72h deadline.
   *
   * @returns Array of auto-rejection records created.
   */
  escalateExpired(nowDate?: Date): SignOffRecord[] {
    const rejections: SignOffRecord[] = [];

    for (const [candidateId, request] of this.pending.entries()) {
      if (this.isExpired(request, nowDate)) {
        const record = this.recordDecision(
          candidateId,
          "system:escalation",
          "rejected",
          "Auto-rejected: approver unavailable >72h (Art. 14 escalation — never auto-approved)",
          nowDate,
        );
        rejections.push(record);
      }
    }

    return rejections;
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /**
   * Returns the first approved sign-off for a candidate, or null if none exists.
   * One sign-off is sufficient for promotion.
   */
  getApproval(candidateId: string): SignOffRecord | null {
    const records = this.records.get(candidateId) ?? [];
    return (
      records.find((r) => r.decision === "approved" && r.approverId !== "system:escalation") ?? null
    );
  }

  /**
   * Returns all sign-off records for a candidate (audit trail).
   */
  getAuditTrail(candidateId: string): SignOffRecord[] {
    return this.records.get(candidateId) ?? [];
  }

  /**
   * Returns true if a pending request exists and has not expired.
   */
  hasPending(candidateId: string, nowDate?: Date): boolean {
    const request = this.pending.get(candidateId);
    if (!request) return false;
    return !this.isExpired(request, nowDate);
  }

  // ── Verification ────────────────────────────────────────────────────────────

  /**
   * Verify the integrity of a sign-off record by recomputing its hash.
   */
  verifyRecord(record: SignOffRecord): boolean {
    const expected = computeSignedHash(
      record.candidateId,
      record.decision,
      record.rationale,
      record.timestamp,
    );
    return expected === record.signedHash;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private isExpired(request: PendingRequest, nowDate?: Date): boolean {
    const deadline = new Date(request.deadlineAt).getTime();
    const now = (nowDate ?? new Date()).getTime();
    return now > deadline;
  }
}
