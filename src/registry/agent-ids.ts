/**
 * Agent UUIDs — deterministic identifiers per agent archetype.
 *
 * These UUIDs attribute decisions to specific agent archetypes when calling
 * Brain's `record_decision` MCP tool. They MUST remain stable across deploys
 * so decision chains can be correlated over time.
 *
 * Derivation: UUIDv5 with a fixed namespace (`AGENT_ID_NAMESPACE`) and the
 * archetype name as the seed. This makes them reproducible if ever lost.
 *
 * Namespace: `a6f9c2e4-8b5d-4e3f-a1c7-9d2b6e8f1a3c` (generated once, fixed).
 */

/** The five core Command Center agent archetypes. */
export type AgentType =
  | "ARCHITECT"
  | "BUILDER"
  | "TESTER"
  | "SCRIBE"
  | "SYNERGY";

/** Namespace UUID used to derive agent archetype IDs. Frozen forever. */
export const AGENT_ID_NAMESPACE = "a6f9c2e4-8b5d-4e3f-a1c7-9d2b6e8f1a3c";

/**
 * Fixed UUIDs for each Command Center agent archetype.
 *
 * These IDs are the `agent_id` parameter in Brain's `record_decision` MCP tool
 * and become the foreign key on `decision_chains.agent_id`.
 *
 * DO NOT regenerate — any change breaks decision-chain history correlation.
 */
export const AGENT_IDS: Readonly<Record<AgentType, string>> = Object.freeze({
  ARCHITECT: "449287f0-db80-5f95-baf7-31a7e52adac6",
  BUILDER: "4c85dcf3-a4a9-5f8d-9b6d-b1275b799656",
  TESTER: "bae97868-daa2-56f7-9a64-23791f62110d",
  SCRIBE: "c371feea-bf3c-506d-92ef-f4cbf4d652f9",
  SYNERGY: "3362a6cf-b69a-5c52-ba44-3561a4b4563c",
});

/** Resolve the deterministic UUID for an agent archetype. Throws on unknown input. */
export function getAgentId(agent: AgentType): string {
  const id = AGENT_IDS[agent];
  if (!id) {
    throw new Error(`Unknown agent archetype: ${agent}`);
  }
  return id;
}

/** Reverse lookup — find the agent archetype from its UUID. Returns undefined if not found. */
export function agentFromId(id: string): AgentType | undefined {
  for (const [agent, agentId] of Object.entries(AGENT_IDS)) {
    if (agentId === id) return agent as AgentType;
  }
  return undefined;
}
