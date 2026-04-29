/**
 * Universal proof-layer entrypoint for the agent-sdk — sprint-483.
 * Extended: sprint-521 Bloc 1 — Poseidon proof module.
 *
 * Re-exports the leaf builders so external consumers can compute or verify
 * universal proof leaves WITHOUT depending on the command-center monolith.
 *
 * The implementation lives in command-center/src/proof/* and is re-exported
 * via a thin shim. Cross-language parity is guaranteed by the same SHA-256
 * + JCS test vectors (tests/proof/cross-lang-vectors.json).
 *
 * Usage:
 *   import { mkProofLeaf, verifyProofInclusion } from "@vauban-org/agent-sdk/proof";
 *
 *   const leaf = mkProofLeaf("hitl_approval", row);
 *   const ok = verifyProofInclusion(leaf.preimage_hash, proof, root);
 */

import { createHash } from "node:crypto";

// ─── JCS canonical JSON (RFC 8785 subset) ────────────────────────────────────

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = normalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalize(data: Record<string, unknown>): string {
  return JSON.stringify(normalize(data));
}

export function leafHash(data: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(data), "utf8").digest("hex");
}

// ─── Merkle proof verification ────────────────────────────────────────────────

function hashPair(left: string, right: string): string {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return createHash("sha256")
    .update(Buffer.from(a, "hex"))
    .update(Buffer.from(b, "hex"))
    .digest("hex");
}

export function verifyProofInclusion(
  leaf: string,
  proof: string[],
  root: string,
): boolean {
  let current = leaf.startsWith("0x") ? leaf.slice(2) : leaf;
  for (const sibling of proof) {
    const sib = sibling.startsWith("0x") ? sibling.slice(2) : sibling;
    current = hashPair(current, sib);
  }
  return current === root;
}

// ─── Universal source-table dispatch ──────────────────────────────────────────

export type UniversalSourceTable =
  | "hitl_approval"
  | "agent_config_history"
  | "pending_agent_config_change"
  | "agent_run"
  | "outcome_ledger";

export interface ProofLeaf {
  preimage_hash: string;
  leaf_felt: string;
}

function req(row: Record<string, unknown>, field: string): unknown {
  const v = row[field];
  if (v === undefined) {
    throw new Error(`[proof] missing field "${field}"`);
  }
  return v;
}

function asISO(v: unknown, field: string): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  throw new Error(`[proof] field "${field}" must be Date or ISO string`);
}

function asNullableISO(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  return asISO(v, field);
}

function asInt(v: unknown, field: string): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (typeof v === "bigint") return Number(v);
  throw new Error(`[proof] field "${field}" must be integer`);
}

function lower(v: unknown, field: string): string {
  if (typeof v !== "string") {
    throw new Error(`[proof] field "${field}" must be string`);
  }
  return v.toLowerCase();
}

const CANONICALIZERS: Record<
  UniversalSourceTable,
  (row: Record<string, unknown>) => Record<string, unknown>
> = {
  hitl_approval: (row) => ({
    id: String(req(row, "id")),
    agent_id: String(req(row, "agent_id")),
    decision: lower(req(row, "decision"), "decision"),
    evidence_hash: String(req(row, "evidence_hash")),
    resolved_at: asISO(req(row, "resolved_at"), "resolved_at"),
  }),
  agent_config_history: (row) => {
    const patch = req(row, "patch");
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(`[proof] patch must be object`);
    }
    return {
      agent_id: String(req(row, "agent_id")),
      patch: patch as Record<string, unknown>,
      version: asInt(req(row, "version"), "version"),
      changed_at: asISO(req(row, "changed_at"), "changed_at"),
    };
  },
  agent_run: (row) => ({
    id: String(req(row, "id")),
    agent_id: String(req(row, "agent_id")),
    status: lower(req(row, "status"), "status"),
    evidence_hash: String(req(row, "evidence_hash")),
    duration_ms: asInt(req(row, "duration_ms"), "duration_ms"),
  }),
  pending_agent_config_change: (row) => {
    const patch = req(row, "proposed_patch");
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error(`[proof] proposed_patch must be object`);
    }
    return {
      id: String(req(row, "id")),
      agent_id: String(req(row, "agent_id")),
      proposed_patch: patch as Record<string, unknown>,
      status: lower(req(row, "status"), "status"),
      resolved_at: asNullableISO(row.resolved_at, "resolved_at"),
    };
  },
  outcome_ledger: (row) => {
    const v = row.value_centimes;
    if (typeof v === "number" && !Number.isInteger(v)) {
      throw new Error(
        `[proof] outcome_ledger.value_centimes must be integer centimes`,
      );
    }
    return {
      id: String(req(row, "id")),
      agent_id: String(req(row, "agent_id")),
      outcome_type: lower(req(row, "outcome_type"), "outcome_type"),
      value_centimes: asInt(req(row, "value_centimes"), "value_centimes"),
      recorded_at: asISO(req(row, "recorded_at"), "recorded_at"),
    };
  },
};

export function mkProofLeaf(
  sourceTable: UniversalSourceTable,
  row: Record<string, unknown>,
): ProofLeaf {
  const fn = CANONICALIZERS[sourceTable];
  if (!fn) throw new Error(`[proof] unknown source: ${sourceTable}`);
  const hash = leafHash(fn(row));
  return { preimage_hash: hash, leaf_felt: `0x${hash}` };
}

// ─── Sprint-521 Bloc 1: Poseidon proof module ─────────────────────────────────

export type {
  CertState,
  LogSeverity,
  RunStep,
  RunProofCertificate,
} from "./types.js";
export { computeLeafHash, computeMerkleRoot, NULL_LEAF } from "./poseidon.js";
export type { VerifyResult } from "./verify.js";
export { verifyProofCertificate } from "./verify.js";
export type { LoadProofCertificateOptions } from "./load.js";
export { loadProofCertificate } from "./load.js";
export type { OtelSpan } from "./otel.js";
export { toOtelSpan } from "./otel.js";
