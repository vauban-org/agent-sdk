/**
 * ProofChain — tamper-evident SHA-256 step chain for TRACE_V1.
 *
 * Coexists with the legacy Poseidon proof system in `./poseidon.ts`.
 * This module targets the TRACE_V1 schema (sprint-561:a2/a4).
 *
 * buildChain  — builds a ProofChain from a finalized Trace.
 * verifyChain — runs 7 integrity checks (R8-M4, CH9, AR6).
 *
 * rootHash binding (CH9):
 *   rootHash = sha256(canonical({
 *     lastStepHash,
 *     totalSteps,
 *     configHash,    ← anti config-swap
 *     agentId,
 *     agentVersion,
 *     runId,
 *   }))
 *
 * All-zeros prevStepHash sentinel for step[0]:
 *   "0000000000000000000000000000000000000000000000000000000000000000"
 *
 * @module proof/chain
 */

import { canonicalize } from "../trace/canonical.js";
import type { Trace, TraceStep } from "../trace/schema.js";
import { sha256 } from "./sha256.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** @public */
export interface ProofChainEntry {
  /** Zero-based step index (mirrors TraceStep.index). */
  index: number;
  /** SHA-256(canonical({ ...step fields (excl. stepHash), runId })). */
  stepHash: string;
}

/** @public */
export interface ProofChain {
  /** Hash algorithm identifier. Always sha-256 in this schema version. */
  algorithm: "sha-256";
  /** One entry per step; ordered by index. */
  entries: ProofChainEntry[];
  /**
   * SHA-256(canonical({ lastStepHash, totalSteps, configHash, agentId, agentVersion, runId })).
   * Binds config, identity, and chain tail into a single commitment (CH9).
   */
  rootHash: string;
}

/**
 * Discriminated union returned by verifyChain.
 * R8-M4: receiptStatus propagated on BOTH branches when present.
 * @public
 */
export type VerifyChainResult =
  | {
      valid: true;
      receiptStatus?: "present" | "pending" | "failed";
    }
  | {
      valid: false;
      /** Zero-based index of the first tampered step, or -1 for structural errors. */
      tamperedAt: number;
      reason: string;
      receiptStatus?: "present" | "pending" | "failed";
    };

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * All-zeros sentinel for prevStepHash of the first step.
 * @public
 */
export const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// ─── computeStepHash ─────────────────────────────────────────────────────────

/**
 * SHA-256(canonical({ ...step fields (excluding stepHash), runId })).
 *
 * The stepHash field itself is excluded from its own digest to avoid
 * circular dependency. runId is included explicitly even though it is
 * already a step field — this is intentional for AR6 clarity.
 * @public
 */
export async function computeStepHash(step: TraceStep, runId: string): Promise<string> {
  const { stepHash: _excluded, ...stepWithoutHash } = step;
  void _excluded;
  const payload = { ...stepWithoutHash, runId };
  return sha256(canonicalize(payload));
}

// ─── buildChain ──────────────────────────────────────────────────────────────

/**
 * Build a ProofChain from a finalized Trace.
 *
 * Recomputes stepHash for every step to produce the entries array,
 * then computes rootHash = sha256(canonical({ lastStepHash, totalSteps,
 * configHash, agentId, agentVersion, runId })).
 *
 * @throws If the trace has no steps.
 * @public
 */
export async function buildChain(trace: Trace): Promise<ProofChain> {
  if (trace.steps.length === 0) {
    throw new Error("buildChain: trace must have at least one step");
  }

  const entries: ProofChainEntry[] = [];

  for (const step of trace.steps) {
    const stepHash = await computeStepHash(step, trace.runId);
    entries.push({ index: step.index, stepHash });
  }

  const lastStepHash = entries[entries.length - 1].stepHash;

  const rootPayload = {
    agentId: trace.agentId,
    agentVersion: trace.agentVersion,
    configHash: trace.configHash,
    lastStepHash,
    runId: trace.runId,
    totalSteps: trace.totalSteps,
  };

  const rootHash = await sha256(canonicalize(rootPayload));

  return { algorithm: "sha-256", entries, rootHash };
}

// ─── verifyChain ─────────────────────────────────────────────────────────────

/**
 * Verify a ProofChain against a Trace — 7 integrity checks.
 *
 * Checks (in order):
 *   1. steps[i].index === i                    (monotone, anti-deletion)
 *   2. steps.length === trace.totalSteps        (anti-truncation)
 *   3. steps[i].runId === trace.runId for all i (anti-splice AR6)
 *   4. recompute stepHash === step.stepHash     (data integrity)
 *   5. steps[i].prevStepHash === steps[i-1].stepHash (chain linkage)
 *   6. rootHash === recomputed rootHash         (root commitment CH9)
 *   7. trace.configHash === sha256(canonical(trace.config)) (config anti-swap)
 * @public
 */
export async function verifyChain(trace: Trace, chain: ProofChain): Promise<VerifyChainResult> {
  const receiptStatus = trace.receiptStatus;

  // Check 2 — anti-truncation (check length before iterating)
  if (trace.steps.length !== trace.totalSteps) {
    return {
      valid: false,
      tamperedAt: -1,
      reason: "totalSteps mismatch",
      ...(receiptStatus !== undefined ? { receiptStatus } : {}),
    };
  }

  // Checks 1, 3, 4, 5 — per-step loop
  const computedHashes: string[] = [];
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];

    // Check 1 — monotone index
    if (step.index !== i) {
      return {
        valid: false,
        tamperedAt: i,
        reason: "monotone violation",
        ...(receiptStatus !== undefined ? { receiptStatus } : {}),
      };
    }

    // Check 3 — AR6 runId anti-splice
    if (step.runId !== trace.runId) {
      return {
        valid: false,
        tamperedAt: i,
        reason: "runId mismatch",
        ...(receiptStatus !== undefined ? { receiptStatus } : {}),
      };
    }

    // Check 4 — recompute stepHash
    const recomputedHash = await computeStepHash(step, trace.runId);
    if (recomputedHash !== step.stepHash) {
      return {
        valid: false,
        tamperedAt: i,
        reason: "step hash mismatch",
        ...(receiptStatus !== undefined ? { receiptStatus } : {}),
      };
    }
    computedHashes.push(recomputedHash);

    // Check 5 — chain linkage
    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : computedHashes[i - 1];
    if (step.prevStepHash !== expectedPrev) {
      return {
        valid: false,
        tamperedAt: i,
        reason: "prev hash mismatch",
        ...(receiptStatus !== undefined ? { receiptStatus } : {}),
      };
    }
  }

  // Check 6 — root hash
  const lastStepHash = computedHashes[computedHashes.length - 1];
  const rootPayload = {
    agentId: trace.agentId,
    agentVersion: trace.agentVersion,
    configHash: trace.configHash,
    lastStepHash,
    runId: trace.runId,
    totalSteps: trace.totalSteps,
  };
  const recomputedRoot = await sha256(canonicalize(rootPayload));
  if (chain.rootHash !== recomputedRoot) {
    return {
      valid: false,
      tamperedAt: -1,
      reason: "root hash mismatch",
      ...(receiptStatus !== undefined ? { receiptStatus } : {}),
    };
  }

  // Check 7 — CH9 config hash
  const recomputedConfigHash = await sha256(canonicalize(trace.config));
  if (trace.configHash !== recomputedConfigHash) {
    return {
      valid: false,
      tamperedAt: -1,
      reason: "config hash mismatch",
      ...(receiptStatus !== undefined ? { receiptStatus } : {}),
    };
  }

  return {
    valid: true,
    ...(receiptStatus !== undefined ? { receiptStatus } : {}),
  };
}
