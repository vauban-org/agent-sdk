export { AgentRegistry, agentRegistry } from "./agent-registry.js";
export type {
  AgentDescriptor,
  AgentHandler,
  AgentContext,
  AgentResult,
} from "./agent-registry.js";

export {
  AGENT_IDS,
  AGENT_ID_NAMESPACE,
  getAgentId,
  agentFromId,
} from "./agent-ids.js";
export type { AgentType } from "./agent-ids.js";
