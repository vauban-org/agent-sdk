/**
 * Proof module types — @vauban-org/agent-sdk v0.5.2 (sprint-521 Bloc 1).
 *
 * Mirrors src/proof/run-certificate.ts so cert.json fetched from
 * /api/runs/:id/proof-certificate parses cleanly into these types.
 *
 * Intentionally kept free of server-side dependencies (no DbClient, no crypto).
 */

export type CertState = "awaiting_anchor" | "anchored" | "verified_on_chain";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface RunStep {
  id: string;
  run_id: string;
  step_index: number;
  parent_step_id?: string | null;
  type: "retrieval" | "decision" | "execution" | "feedback" | "observation";
  phase?: string | null;
  status: "pending" | "done" | "error" | "skipped";
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  payload?: Record<string, unknown> | null;
  leaf_hash_poseidon?: string | null;
  mcp_call_hash?: string | null;
  retrieval_proof_hash?: string | null;
  otel_trace_id?: string | null;
  otel_span_id?: string | null;
  error_message?: string | null;
}

export interface RunProofCertificate {
  run_id: string;
  agent_id: string;
  started_at: string;
  finished_at: string;
  /** Trigger event ID — null if not recorded in run steps. */
  trigger_event_id: string | null;
  /** Brain entry IDs from retrieval steps that had an MCP call hash. */
  brain_context_refs: string[];
  decision_chain: Array<{
    step_id: string;
    step_index: number;
    type: string;
    phase: string | null;
    leaf_hash_poseidon: string;
    started_at: string;
    finished_at: string;
    duration_ms: number | null;
  }>;
  merkle_root: string | null;
  katana_tx: string | null;
  anchor_block_number: number | null;
  state: CertState;
  issued_at: string;
}
