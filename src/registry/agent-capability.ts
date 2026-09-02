/**
 * AgentCapabilityCard — multi-kind capability descriptor for CC LLM router agents.
 *
 * Sprint-580 / registry-multi-kind
 *
 * In-memory schema only. SQL persistence via migration
 * `036_agent_capability_index.sql` (coordinator-applied).
 * @public
 */

// ─── Kinds ────────────────────────────────────────────────────────────────────

export const AGENT_KINDS = [
  "ARCHITECT",
  "BUILDER",
  "SCRIBE",
  "TESTER",
  "SYNERGY",
  "OODA",
  "LLM_ROUTER",
  "PLUGIN",
  "MCP",
] as const;

/** @public */
export type AgentKind = (typeof AGENT_KINDS)[number];

// ─── Tiers ────────────────────────────────────────────────────────────────────

/** @public */
export type CostTier = "low" | "medium" | "high";
/** @public */
export type LatencyTier = "low" | "medium" | "high";

// ─── Card ─────────────────────────────────────────────────────────────────────

/** @public */
export interface AgentCapabilityCard {
  /** Stable agent identifier (matches AgentDescriptor.id or AGENT_IDS UUID). */
  agentId: string;
  /** Kind classifier for this capability entry. */
  kind: AgentKind;
  /** Free-form skill tags, lowercased. */
  skills: readonly string[];
  /** Relative cost to invoke this agent. */
  costTier: CostTier;
  /** Relative latency of this agent. */
  latencyTier: LatencyTier;
  /** pgvector similarity embedding — optional in in-memory mode. */
  embeddingVector?: readonly number[];
  /** Unix epoch ms when this card was registered. */
  createdAt: number;
}
