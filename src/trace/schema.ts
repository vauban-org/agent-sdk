/**
 * TRACE_V1 schema — Audit-ready immutable trace format.
 *
 * Design:
 *   - Chain-of-custody via prevStepHash + stepHash (SHA-256 Merkle chain).
 *   - Anti-splice: every step carries runId (AR6).
 *   - Anti-truncation: Trace.totalSteps cross-verified against steps.length.
 *   - HITL transitions: via 'hitl' phase + 'hitl_gate' type (no parentStepIndex — hierarchy via 'handoff_initiated' event, R8-B2).
 *   - TSA receipt optional (present | pending | failed).
 *   - Config hash (CH9): configHash = SHA-256(canonical(config)).
 *   - Agent signature reserved (CH8).
 *
 * @module trace/schema
 */

/** Semver version of this trace schema. Increment MINOR on additive changes,
 *  MAJOR on breaking changes (new required fields or removed fields). * @public
 */
export const TRACE_SCHEMA_VERSION = "1.0.0" as const;

/**
 * Status of an optional TSA receipt for a Trace.
 * @public
 */
export type ReceiptStatus = "present" | "pending" | "failed";

/**
 * A single step in a ReAct/OODA agent run.
 * Steps form an append-only chain: each step hashes its predecessor.
 * @public
 */
export interface TraceStep {
  /** Zero-based monotone index within the run. */
  index: number;

  /**
   * Run identifier — repeated on every step to prevent splice attacks (AR6).
   * Cross-verified against Trace.runId at verification time.
   */
  runId: string;

  /**
   * OODA / ReAct phase of this step.
   * - observe: input collection / perception
   * - orient: context enrichment / memory retrieval
   * - decide: LLM reasoning step
   * - act: tool execution / side-effect
   * - feedback: result integration
   * - guard: safety / policy check
   * - hitl: human-in-the-loop gate
   */
  phase: "observe" | "orient" | "decide" | "act" | "feedback" | "guard" | "hitl";

  /**
   * Structural type of this step.
   * NOTE: hierarchy of sub-agents is encoded via a 'handoff_initiated'
   * event (R8-B2) — NOT via parentStepIndex, which is intentionally absent.
   */
  type: "llm_call" | "tool_call" | "guard_check" | "phase_transition" | "hitl_gate";

  /** Unix epoch milliseconds when this step started. */
  timestamp: number;

  /** Wall-clock duration of this step in milliseconds. */
  durationMs: number;

  /**
   * SHA-256(canonical(redacted_or_hashed_input)).
   * Always present regardless of policy.
   */
  inputHash: string;

  /**
   * HMAC-SHA-256(canonical(original_input), out-of-band_key).
   * Present only when policy is 'hmac'. Allows offline re-verification
   * without storing plaintext.
   */
  inputOriginalHmac?: string;

  /**
   * Stored payload according to the policy:
   *   - 'include': full redacted value
   *   - 'redact': object with PII fields removed
   *   - 'hmac': undefined (only hash + hmac stored)
   *   - 'hash-only': undefined
   */
  storedInput?: unknown;

  /** SHA-256(canonical(redacted_or_hashed_output)). Always present. */
  outputHash: string;

  /** HMAC-SHA-256(canonical(original_output), out-of-band_key). Present when policy is 'hmac'. */
  outputOriginalHmac?: string;

  /** Stored output payload per policy (same semantics as storedInput). */
  storedOutput?: unknown;

  /**
   * Effective payload policy for this step.
   * Derived from PayloadPolicy.kind at trace-build time.
   */
  policy: "include" | "redact" | "hmac" | "hash-only";

  /** LLM token usage. Undefined for non-LLM steps. */
  tokens?: {
    input: number;
    output: number;
    /** Prompt-cache read tokens (Anthropic / OpenAI). */
    cacheRead?: number;
  };

  /** Estimated cost in USD for this step. Undefined for non-billable steps. */
  costUsd?: number;

  /** LLM model that produced this step. Undefined for non-LLM steps. */
  model?: {
    provider: string;
    name: string;
    version: string;
  };

  /** Tool name for 'tool_call' steps. */
  toolName?: string;

  /** Guard name for 'guard_check' steps. */
  guardName?: string;

  /**
   * Hash of the previous step's stepHash (or all-zeros for step 0).
   * Enables chain-of-custody verification: any tampering or reordering
   * breaks the chain.
   */
  prevStepHash: string;

  /**
   * SHA-256(canonical({ ...step fields (excluding stepHash), runId })).
   * Computed after all other fields are set.
   */
  stepHash: string;
}

/**
 * RFC 3161 / TSA-style timestamping receipt.
 * Optional — traces without a receipt still have integrity via
 * the Merkle chain; the receipt adds a trusted external timestamp.
 * @public
 */
export interface SignedReceipt {
  /** TSA endpoint URL that issued this receipt. */
  tsa: string;
  /** ISO-8601 timestamp from the TSA. */
  timestamp: string;
  /** TSA-issued signature (base64). */
  signature: string;
  /** Hash algorithm used. Always sha-256 in this schema version. */
  algorithm: "sha-256";
  /** The message hash that was timestamped (= Trace.rootHash). */
  hashedMessage: string;
  /** TSA certificate chain (PEM, base64). Optional — may be pinned out-of-band. */
  certChain?: string[];
}

/**
 * A complete, verifiable trace of one agent run.
 *
 * Integrity invariants:
 *   - steps[i].prevStepHash === steps[i-1].stepHash (chain)
 *   - steps[i].runId === runId (anti-splice)
 *   - steps.length === totalSteps (anti-truncation)
 *   - rootHash === SHA-256(canonical(steps.map(s => s.stepHash)))
 *   - configHash === SHA-256(canonical(config)) (CH9)
 * @public
 */
export interface Trace {
  /** Schema version for forward-compatibility checks. */
  schemaVersion: typeof TRACE_SCHEMA_VERSION;

  /** Unique identifier for this run. UUID v4 recommended. */
  runId: string;

  /** Identifier of the agent that produced this trace. */
  agentId: string;

  /** Semantic version of the agent code. */
  agentVersion: string;

  /** Unix epoch milliseconds when the run started. */
  startedAt: number;

  /** Unix epoch milliseconds when the run finished. */
  completedAt: number;

  /** Terminal status of the run. */
  status: "completed" | "failed" | "skipped";

  /** Ordered list of steps. */
  steps: TraceStep[];

  /**
   * Anti-truncation guard: must equal steps.length.
   * A mismatch signals that steps were removed after the trace was finalized.
   */
  totalSteps: number;

  /**
   * SHA-256(canonical(steps.map(s => s.stepHash))).
   * The root of the step Merkle chain.
   */
  rootHash: string;

  /**
   * Arbitrary run configuration (model IDs, pipeline params, env flags, …).
   * Stored as-is; hashed separately for tamper-evidence.
   */
  config: Record<string, unknown>;

  /**
   * SHA-256(canonical(config)) — CH9.
   * Verifiers recompute this to detect config drift between runs.
   */
  configHash: string;

  /**
   * Reserved for a future agent-level signature (CH8).
   * When present, agentSignature = Sign(rootHash, agentPrivKey).
   */
  agentSignature?: string;

  /** TSA receipt if external timestamping was requested. */
  receipt?: SignedReceipt;

  /** Status of the TSA receipt fetch. */
  receiptStatus?: ReceiptStatus;

  /**
   * Unix epoch milliseconds for the next receipt retry attempt.
   * Set when receiptStatus === 'pending'.
   */
  receiptRetryAt?: number;
}
