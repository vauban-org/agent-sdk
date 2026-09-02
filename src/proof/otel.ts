/**
 * toOtelSpan — maps a RunStep to an OpenTelemetry span shape.
 *
 * Follows OpenInference semantic conventions for GenAI:
 *   https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * sprint-521 Bloc 1.
 */

import {
  VAUBAN_ASSURANCE_CONE_MIN,
  VAUBAN_ASSURANCE_GRADE,
  VAUBAN_ASSURANCE_UNAVAILABLE,
} from "../otel/attributes.js";
import type { RunStep } from "./types.js";

// ─── Injected grading engine (explicit port, no ambient import) ───────────────
// The assurance grading engine lives in a private workspace package that is
// never published, and this module carries NO reference to it — not an import,
// not a name in package.json. A host that has the engine injects it once at
// bootstrap via {@link setAssuranceGradingEngine}; everyone else (every install
// outside the vauban-org workspace) simply never injects. Without an engine the
// grade attributes are deliberately OMITTED and the span carries the explicit
// VAUBAN_ASSURANCE_UNAVAILABLE marker instead — the absence of the measuring
// tool is stated, never rendered as a grade (an "A0" means "zero evidence",
// which is a verdict this code has no basis to emit).
// Why injection rather than a lazy optional import: a top-level await on an
// external module deadlocks esbuild's init chain in bundled consumers (Node
// exit 13, unsettled TLA — measured on the preste bundle), and a fire-and-
// forget load races its first callers. Injection is synchronous, deterministic,
// and leaves zero trace of the private package in any published artifact.

interface StepEvidenceLike {
  leaf_hash_poseidon?: string | null;
  retrieval_proof_hash?: string | null;
  mcp_call_hash?: string | null;
  external_verifier_grade?: string | null;
}
interface ConeStepLike extends StepEvidenceLike {
  id: string;
  parent_step_id?: string | null;
}
export interface AssuranceGradingEngine {
  deriveStepGrade: (ev: StepEvidenceLike) => string;
  deriveConeGrade: (steps: readonly ConeStepLike[], id: string) => string;
}

let grading: AssuranceGradingEngine | undefined;

/**
 * Inject (or clear, with `undefined`) the assurance grading engine used by
 * {@link toOtelSpan}. Call once at host bootstrap; idempotent.
 */
export function setAssuranceGradingEngine(engine: AssuranceGradingEngine | undefined): void {
  grading = engine;
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  attributes: Record<string, string | number | boolean>;
}

/**
 * Map a RunStep to an OpenTelemetry-compatible span descriptor.
 *
 * Uses OpenInference semantic conventions (gen_ai.*) for GenAI observability.
 * traceId and spanId fall back to empty strings if not set on the step.
 *
 * When `allSteps` is provided AND the grading engine is installed, the span
 * additionally carries `vauban.assurance.cone_min`: the aggregate over the
 * backward dependency cone of `step` (its transitive `parent_step_id` closure).
 * This is intended for the root / orchestrator span ; per-step spans omit it.
 * Without the grading engine, both grade attributes are omitted and
 * `vauban.assurance.unavailable` is set to `true` instead.
 *
 * @param step     - RunStep from the proof certificate decision_chain or run.
 * @param allSteps - Optional full step set for the cone-min aggregate.
 * @returns OtelSpan with traceId, spanId, and attributes.
 */
export function toOtelSpan(step: RunStep, allSteps?: readonly RunStep[]): OtelSpan {
  const traceId = step.otel_trace_id ?? "";
  const spanId = step.otel_span_id ?? "";

  const attributes: Record<string, string | number | boolean> = {
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

  if (grading !== undefined) {
    attributes[VAUBAN_ASSURANCE_GRADE] = grading.deriveStepGrade(step);
    if (allSteps !== undefined) {
      attributes[VAUBAN_ASSURANCE_CONE_MIN] = grading.deriveConeGrade(allSteps, step.id);
    }
  } else {
    attributes[VAUBAN_ASSURANCE_UNAVAILABLE] = true;
  }

  return { traceId, spanId, attributes };
}
