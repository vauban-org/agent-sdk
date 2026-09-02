/**
 * src/constitution/types.ts
 *
 * Shared types for the constitution module.
 * CycleSnapshot is a lightweight view of one agent run cycle for scoring purposes.
 * It adapts Trace fields and adds budget / scope context needed by the gate.
 *
 * @module constitution/types
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Signal point — one observable datum from an axiom detector
// ---------------------------------------------------------------------------

/** @public */
export interface SignalPoint {
  /** Axiom-scoped label for this signal (e.g. "timeout_configured"). */
  label: string;
  /**
   * Weight in [−1, 1].
   * Positive = evidence the axiom is satisfied.
   * Negative = evidence the axiom is violated.
   */
  weight: number;
  /** Human-readable evidence string for audit trail. */
  evidence: string;
}

// ---------------------------------------------------------------------------
// GateViolation — single hard-gate rule breach
// ---------------------------------------------------------------------------

/** @public */
export type AxiomId = "Institutionnel" | "SOTA" | "Robuste" | "AntiFragile" | "Profitable";

/** @public */
export type GateSeverity = "block";

/** @public */
export interface GateViolation {
  axiom: AxiomId;
  severity: GateSeverity;
  rule: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// CycleSnapshot — minimal runtime view of an agent cycle
// ---------------------------------------------------------------------------

/**
 * A single recorded step within a cycle, simplified for constitution use.
 * @public
 */
export interface CycleStep {
  /** Zero-based monotone index. */
  index: number;
  /** Phase of this step (mirrors TraceStep.phase). */
  phase: string;
  /** Type of this step (mirrors TraceStep.type). */
  type: string;
  /** Serialised (and potentially redacted) output payload. Used for secret scanning. */
  output?: unknown;
  /** Stored input payload (mirrors TraceStep.storedInput). Used for PII detection. */
  storedInput?: unknown;
  /** LLM model that produced this step, if any. */
  model?: {
    provider: string;
    name: string;
    version: string;
  };
  /** Name of the tool invoked, for 'tool_call' steps. */
  toolName?: string;
  /** Estimated cost in USD for this step. */
  costUsd?: number;
}

/**
 * Arbitrary metadata the host attaches to the cycle at submission time.
 * @public
 */
export interface CycleMetadata {
  /** If true the RSO has issued a veto on this cycle before evaluation. */
  rso_veto?: boolean;
  /** Hash primitive used by the agent (e.g. "poseidon", "keccak256"). */
  hash_primitive?: string;
  /** Whether a fallback path exists for this cycle (resilience signal). */
  has_fallback?: boolean;
  /** Whether the cycle's primary operation is idempotent. */
  is_idempotent?: boolean;
  /** Number of independent data / funding sources. */
  source_count?: number;
  /** Model provider name for recency analysis. */
  model_provider?: string;
  /** Model name for recency analysis. */
  model_name?: string;
  /** Whether SLSA supply-chain level ≥ 3 artefacts were used. */
  slsa_level?: number;
  /** Whether explicit timeouts are configured on all external calls. */
  timeouts_configured?: boolean;
  /** Whether error paths are explicit (no silent swallowing). */
  error_paths_explicit?: boolean;
  /** Whether cross-agent payloads with PII have been redacted. */
  pii_redacted?: boolean;
  /**
   * Explicit audit-trail completeness flag.
   * When true, the host asserts all steps are recorded and the rootHash is finalized.
   */
  audit_trail_complete?: boolean;
  /**
   * Regulatory scope this cycle operates under.
   * Well-known values: "eIDAS", "gdpr", "ai-act-art-14".
   * Used by the Institutionnel scorer to reward explicit regulatory alignment.
   */
  regulatory_scope?: string;
  /**
   * Opaque field bag — any additional host-side metadata.
   */
  [key: string]: unknown;
}

/**
 * CycleSnapshot — the unit of analysis for constitutional scoring.
 *
 * Designed to be a strict subset of Trace (re-using `rootHash` and `steps`
 * semantics) with additional budget / scope fields required by the gate.
 * @public
 */
export interface CycleSnapshot {
  /** Unique run identifier (mirrors Trace.runId). */
  runId: string;
  /** Parent run identifier when this is a child cycle. */
  parentRunId?: string;
  /** Ordered steps of this cycle. */
  steps: CycleStep[];
  /**
   * Maximum allowed budget in USD for this cycle.
   * Gate blocks child cycles that exceed the parent's budget.
   */
  budgetUsdMax: number;
  /** Actual USD spent so far in this cycle. */
  budgetUsdSpent: number;
  /** Scope identifier — must be within parent's allowed_scope_ids. */
  scope_id?: string;
  /** Arbitrary metadata from the host. */
  metadata?: CycleMetadata;
  /**
   * SHA-256 root hash of the step chain (mirrors Trace.rootHash).
   * Presence confirms the cycle was finalized with integrity.
   */
  rootHash: string;
}

// ---------------------------------------------------------------------------
// Zod schema for CycleSnapshot — used by gate input validation
// ---------------------------------------------------------------------------

const cycleStepSchema = z.object({
  index: z.number().int().nonnegative(),
  phase: z.string(),
  type: z.string(),
  output: z.unknown().optional(),
  storedInput: z.unknown().optional(),
  model: z
    .object({
      provider: z.string(),
      name: z.string(),
      version: z.string(),
    })
    .optional(),
  toolName: z.string().optional(),
  costUsd: z.number().optional(),
});

const cycleMetadataSchema = z
  .object({
    rso_veto: z.boolean().optional(),
    hash_primitive: z.string().optional(),
    has_fallback: z.boolean().optional(),
    is_idempotent: z.boolean().optional(),
    source_count: z.number().optional(),
    model_provider: z.string().optional(),
    model_name: z.string().optional(),
    slsa_level: z.number().optional(),
    timeouts_configured: z.boolean().optional(),
    error_paths_explicit: z.boolean().optional(),
    pii_redacted: z.boolean().optional(),
    audit_trail_complete: z.boolean().optional(),
    regulatory_scope: z.string().optional(),
  })
  .passthrough();

/** @public */
export const cycleSnapshotSchema = z
  .object({
    runId: z.string().min(1),
    parentRunId: z.string().optional(),
    steps: z.array(cycleStepSchema),
    budgetUsdMax: z.number().nonnegative(),
    budgetUsdSpent: z.number().nonnegative(),
    scope_id: z.string().optional(),
    metadata: cycleMetadataSchema.optional(),
    rootHash: z.string().min(1),
  })
  .strict();
