/**
 * CitadelActionPort — host adapter for Citadel governance operations.
 *
 * Implements tiered access control (T1-T4) per BYOA (Bring Your Own Agent) framework.
 * Only T3+ agents can seal sprints, T1 is read-only, T4 requires on-chain signing.
 *
 * Source: MASTER-PLAN-v5.md §1.3 (CC service layer) + vauban-gouvernance/rules/ai/tiered-gates.md
 * @public
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type AgentTier = "T1" | "T2" | "T3" | "T4";
/** @public */
export type TaskStatus = "todo" | "in_progress" | "done" | "blocked" | "rejected";

/** @public */
export interface SprintInput {
  readonly name: string;
  readonly goal?: string;
  readonly start_date?: string; // ISO 8601
  readonly end_date?: string;
  readonly project_slug: string;
}

/** @public */
export interface TaskRef {
  readonly ref: string; // format: "project:sprint-N:task-id"
  readonly project: string;
  readonly sprint: string;
  readonly task_id: string;
}

/** @public */
export interface VerificationEvidence {
  readonly passed: boolean;
  readonly evidence_text: string;
  readonly evidence_hash: string; // sha256 hex
}

/** @public */
export interface DecisionInput {
  readonly decision: string;
  readonly context: string;
  readonly options: readonly string[];
  readonly chosen: string;
  readonly rationale: string;
  readonly tags?: readonly string[];
}

/** @public */
export interface ActionContext {
  readonly agentId: string;
  readonly agentTier: AgentTier;
  readonly runId: string;
  readonly tenantId?: string;
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** @public */
export interface SprintRef {
  readonly sprint_id: string;
  readonly project_slug: string;
  readonly name: string;
  readonly created_at: Date;
}

/** @public */
export interface SealedSprintClaim {
  readonly sprint_id: string;
  readonly sealed_at: Date;
  readonly verification_evidence_hash: string;
  readonly sealed_by_agent: string;
  readonly anchor_id?: string; // L3 blockchain anchor
}

/** @public */
export interface DecisionClaim {
  readonly decision_id: string;
  readonly created_at: Date;
  readonly archived_to_brain: boolean;
  readonly cascade_triggered?: boolean; // ADR cascade hook
}

// ─── Port interface ────────────────────────────────────────────────────────

/** @public */
export interface CitadelActionPort {
  /**
   * Create a new sprint in a project.
   * T2+ only. T1 throws CitadelTierViolationError.
   */
  createSprint(input: SprintInput, ctx: ActionContext): Promise<SprintRef>;

  /**
   * Update task status within a sprint.
   * T2+ can transition: todo→in_progress, in_progress→done, *→blocked.
   * T3+ can seal (→done with verification).
   */
  updateTaskStatus(ref: TaskRef, status: TaskStatus, ctx: ActionContext): Promise<void>;

  /**
   * Seal a completed sprint with verification evidence.
   * T3+ only. Emits SealedSprintClaim (anchor to L3 deferred Phase 1+).
   * Verification evidence hash proves execution of verification_scenario.
   */
  sealSprint(
    sprintId: string,
    evidence: VerificationEvidence,
    ctx: ActionContext,
  ): Promise<SealedSprintClaim>;

  /**
   * Record a decision to governance layer.
   * T2+ can record. T3+ triggers optional ADR cascade hook.
   * Returns DecisionClaim with Brain archive status.
   */
  recordDecision(decision: DecisionInput, ctx: ActionContext): Promise<DecisionClaim>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────

/** @public */
export class CitadelTierViolationError extends Error {
  constructor(
    message: string,
    public readonly required_tier: AgentTier,
    public readonly actual_tier: AgentTier,
    public readonly operation: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CitadelTierViolationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class CitadelTaskRefNotFoundError extends Error {
  constructor(
    public readonly task_ref: string,
    public readonly cause?: unknown,
  ) {
    super(`Task not found: ${task_ref}`);
    this.name = "CitadelTaskRefNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class CitadelSprintNotActiveError extends Error {
  constructor(
    public readonly sprint_id: string,
    public readonly current_status: string,
    public readonly cause?: unknown,
  ) {
    super(`Sprint ${sprint_id} is not active (status: ${current_status}). Cannot seal.`);
    this.name = "CitadelSprintNotActiveError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class CitadelInvalidStateTransitionError extends Error {
  constructor(
    public readonly current_status: TaskStatus,
    public readonly requested_status: TaskStatus,
    public readonly cause?: unknown,
  ) {
    super(`Invalid state transition: ${current_status} → ${requested_status}`);
    this.name = "CitadelInvalidStateTransitionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
