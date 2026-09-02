/**
 * Shared agent types — promoted from Forge to SDK (Vague 1.B.1).
 *
 * These types are generic (no Forge-specific business logic) and safe to
 * consume from any SDK consumer (CC, Forge, other agents).
 *
 * Forge-specific types (CitadelContactsPort outcome types, platform clients)
 * remain in `forge/src/agents/shared/types.ts`.
 *
 * @public @since 0.17.0
 */

import type { SkillRegistry } from "../orchestration/ooda/skills.js";
import type { ExecutionMode } from "../orchestration/ooda/types.js";
import type { BrainPort } from "../ports/brain.js";
import type { EventBusPort } from "../ports/event-bus.js";
import type { LoggerPort } from "../ports/logger.js";
import type { DbClient } from "../tracking/agent-run-tracker.js";

// ─── Escalation Levels ────────────────────────────────────────────────────────

/**
 * EscalationLevel — four-tier escalation pyramid for agent actions.
 *
 * - `L0`: Fully autonomous, no human review.
 * - `L1`: Autonomous with local audit log (L1_autonomous in CC SDK).
 * - `L2`: Async review by a human before irreversible effects.
 * - `L3`: Synchronous HITL (Human-In-The-Loop) approval required.
 *
 * Aligned with CC SDK EscalationPyramid terminology via `toSdkEscalationLevel()`.
 * @public
 */
export type EscalationLevel = "L0" | "L1" | "L2" | "L3";

// ─── Agent Action ─────────────────────────────────────────────────────────────

/**
 * AgentAction — declared in the OODA decide phase, consumed by EscalationPyramid.
 *
 * `estimatedCostCents` MUST be an integer (centimes). Never a float.
 *
 * @public
 */
export interface AgentAction {
  /** Discriminant for the action type (e.g. "post_tweet", "record_outcome"). */
  readonly type: string;
  /** Escalation tier required before execution. */
  readonly escalationLevel: EscalationLevel;
  /** Whether this action can be undone after execution. */
  readonly reversible: boolean;
  /** Estimated cost in integer centimes (never float). Optional. */
  readonly estimatedCostCents?: number;
  /** Free-form action payload, validated by the consumer. */
  readonly payload: Record<string, unknown>;
}

// ─── Agent Dependencies ───────────────────────────────────────────────────────

/**
 * AgentDependencies — generic dependency bundle injected at agent construction.
 *
 * Only generic, host-level dependencies are included here. Forge-specific
 * dependencies (xClient, farcasterClient, rempartClient, citadelContacts,
 * platform webhooks) remain in Forge's local type extension.
 *
 * Consumer agents may extend this interface for their own extras:
 * ```ts
 * interface MyAgentDeps extends AgentDependencies {
 *   myClient: MyClient;
 * }
 * ```
 *
 * @public
 */
export interface AgentDependencies {
  /** Brain memory port (working + episodic + semantic + procedural tiers). */
  readonly brain: BrainPort;
  /** Database client for run tracking and persistence. */
  readonly db: DbClient;
  /** Structured logger (Pino-compatible). */
  readonly logger: LoggerPort;
  /** Redis client (untyped — consumers cast to their redis client type). */
  readonly redis: unknown;
  /** Skill registry for OODA phases. */
  readonly skills: SkillRegistry;
  /** Execution mode: "dry-run" (no side-effects) or "live". */
  readonly executionMode: ExecutionMode;
  /** LiteLLM base URL for BYOM model routing. Optional. */
  readonly litellmUrl?: string;
  /** Database URL for direct Postgres access. Optional. */
  readonly databaseUrl?: string;
  /** Event bus for cross-product HMAC-signed events (ADR-ECO-017). Optional. */
  readonly eventBus?: EventBusPort;
}
