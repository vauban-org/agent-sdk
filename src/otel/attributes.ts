/**
 * OTel gen_ai.* semantic convention constants for Vauban agents.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * All standard gen_ai.* attributes follow the OTel semantic conventions.
 * Custom Vauban attributes (gen_ai.agent.id, gen_ai.delegation.parent_run_id,
 * gen_ai.cost.usd) are prefixed gen_ai.* to stay in the same namespace.
 */

import type { Span } from "@opentelemetry/api";

// ─── Standard gen_ai.* attribute name constants ───────────────────────────────

/** AI system identifier, e.g. "anthropic", "deepseek", "groq". */
export const GEN_AI_SYSTEM = "gen_ai.system" as const;

/** Model name as requested, e.g. "claude-sonnet-4-6". */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;

/** Maximum token limit requested. */
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens" as const;

/** Actual model used in the response (may differ from request). */
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;

/** Number of input/prompt tokens consumed. */
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;

/** Number of output/completion tokens generated. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;

/** Total tokens (input + output). */
export const GEN_AI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens" as const;

/** High-level operation: "chat" | "completion" | "embedding". */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;

// ─── Custom Vauban gen_ai.* extensions ────────────────────────────────────────

/** Agent / runner identifier (Vauban extension). */
export const GEN_AI_AGENT_ID = "gen_ai.agent.id" as const;

/**
 * Parent run ID for delegation chain tracking (Sprint B).
 * Must match `withDelegationAttribute` in trace-context.ts.
 */
export const GEN_AI_DELEGATION_PARENT_RUN_ID = "gen_ai.delegation.parent_run_id" as const;

/**
 * Computed cost in USD (Vauban extension).
 * Set by OutcomeTracker when available; stub value 0 until wired.
 */
export const GEN_AI_COST_USD = "gen_ai.cost.usd" as const;

/**
 * Assurance grade attribute for the span (Vauban extension). The value is set
 * by the internal grading engine when it is installed ; see
 * {@link VAUBAN_ASSURANCE_UNAVAILABLE} for the explicit marker emitted when it
 * is not.
 */
export const VAUBAN_ASSURANCE_GRADE = "vauban.assurance.grade" as const;

/**
 * Aggregate assurance grade over a span's backward dependency cone (Vauban
 * extension). Set on the root / orchestrator span only ; per-step spans carry
 * {@link VAUBAN_ASSURANCE_GRADE}.
 */
export const VAUBAN_ASSURANCE_CONE_MIN = "vauban.assurance.cone_min" as const;

/**
 * Explicit marker (`true`) that the assurance grading engine was NOT available
 * when this span was emitted : {@link VAUBAN_ASSURANCE_GRADE} and
 * {@link VAUBAN_ASSURANCE_CONE_MIN} are then deliberately absent. Absence of a
 * measurement is stated, never rendered as a grade.
 */
export const VAUBAN_ASSURANCE_UNAVAILABLE = "vauban.assurance.unavailable" as const;

/**
 * Span-link relation type for assurance dependency edges (Vauban extension).
 * Cross-service / cross-process cone reconstruction uses OTel span links tagged
 * with this attribute so an export-time processor can walk them to recompute
 * the cone-min. Value: "assurance_dependency".
 */
export const VAUBAN_LINK_TYPE = "vauban.link.type" as const;

// ─── Typed attribute bag ──────────────────────────────────────────────────────

export interface GenAiAttributes {
  /** @see GEN_AI_SYSTEM */
  "gen_ai.system"?: string;
  /** @see GEN_AI_REQUEST_MODEL */
  "gen_ai.request.model"?: string;
  /** @see GEN_AI_REQUEST_MAX_TOKENS */
  "gen_ai.request.max_tokens"?: number;
  /** @see GEN_AI_RESPONSE_MODEL */
  "gen_ai.response.model"?: string;
  /** @see GEN_AI_USAGE_INPUT_TOKENS */
  "gen_ai.usage.input_tokens"?: number;
  /** @see GEN_AI_USAGE_OUTPUT_TOKENS */
  "gen_ai.usage.output_tokens"?: number;
  /** @see GEN_AI_USAGE_TOTAL_TOKENS */
  "gen_ai.usage.total_tokens"?: number;
  /** @see GEN_AI_OPERATION_NAME */
  "gen_ai.operation.name"?: string;
  /** @see GEN_AI_AGENT_ID */
  "gen_ai.agent.id"?: string;
  /** @see GEN_AI_DELEGATION_PARENT_RUN_ID */
  "gen_ai.delegation.parent_run_id"?: string;
  /** @see GEN_AI_COST_USD */
  "gen_ai.cost.usd"?: number;
  /** @see VAUBAN_ASSURANCE_GRADE ; set by the internal grading engine when installed */
  "vauban.assurance.grade"?: string;
  /** @see VAUBAN_ASSURANCE_CONE_MIN ; aggregate over the span's backward cone */
  "vauban.assurance.cone_min"?: string;
  /** @see VAUBAN_ASSURANCE_UNAVAILABLE ; true when the grading engine is absent */
  "vauban.assurance.unavailable"?: boolean;
  /** @see VAUBAN_LINK_TYPE ; span-link relation type */
  "vauban.link.type"?: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Sets all provided gen_ai.* attributes on a recording span.
 * Undefined values are skipped (not set).
 *
 * @param span  - The OTel Span to annotate (must be recording).
 * @param attrs - Partial bag of gen_ai.* attributes.
 */
export function setGenAiAttributes(span: Span, attrs: Partial<GenAiAttributes>): void {
  const entries = Object.entries(attrs) as [string, string | number | undefined][];
  for (const [key, value] of entries) {
    if (value !== undefined) {
      span.setAttribute(key, value);
    }
  }
}
