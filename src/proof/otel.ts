/**
 * toOtelSpan — maps a RunStep to an OpenTelemetry span shape.
 *
 * Follows OpenInference semantic conventions for GenAI:
 *   https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * sprint-521 Bloc 1.
 */

import type { RunStep } from "./types.js";

export interface OtelSpan {
  traceId: string;
  spanId: string;
  attributes: Record<string, string | number>;
}

/**
 * Map a RunStep to an OpenTelemetry-compatible span descriptor.
 *
 * Uses OpenInference semantic conventions (gen_ai.*) for GenAI observability.
 * traceId and spanId fall back to empty strings if not set on the step.
 *
 * @param step - RunStep from the proof certificate decision_chain or live run.
 * @returns OtelSpan with traceId, spanId, and attributes.
 */
export function toOtelSpan(step: RunStep): OtelSpan {
  const traceId = step.otel_trace_id ?? "";
  const spanId = step.otel_span_id ?? "";

  const attributes: Record<string, string | number> = {
    // OpenInference GenAI conventions
    "gen_ai.system": "vauban-command-center",
    "gen_ai.operation.name": step.type,
    "gen_ai.response.id": step.id,
    // Run context
    "run.id": step.run_id,
    "run.step_index": step.step_index,
    "run.step.type": step.type,
    "run.step.status": step.status,
    "run.step.started_at": step.started_at,
  };

  if (step.phase != null) {
    attributes["run.step.phase"] = step.phase;
  }

  if (step.finished_at != null) {
    attributes["run.step.finished_at"] = step.finished_at;
  }

  if (step.duration_ms != null) {
    attributes["gen_ai.usage.total_tokens"] = step.duration_ms; // duration proxy
    attributes["run.step.duration_ms"] = step.duration_ms;
  }

  if (step.leaf_hash_poseidon != null) {
    attributes["proof.leaf_hash_poseidon"] = step.leaf_hash_poseidon;
  }

  if (step.mcp_call_hash != null) {
    attributes["proof.mcp_call_hash"] = step.mcp_call_hash;
  }

  if (step.retrieval_proof_hash != null) {
    attributes["proof.retrieval_proof_hash"] = step.retrieval_proof_hash;
  }

  if (step.error_message != null) {
    attributes["exception.message"] = step.error_message;
  }

  return { traceId, spanId, attributes };
}
