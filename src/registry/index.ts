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

export { AGENT_KINDS } from "./agent-capability.js";
export type {
  AgentKind,
  AgentCapabilityCard,
  CostTier,
  LatencyTier,
} from "./agent-capability.js";

// ERC-8004-style agent identity (off-chain half) — `registration.json` builder
// + validator. Produces a spec-shaped document any ERC-8004 reader can ingest,
// with the Vauban-native `run-certificate` trust mechanism and the
// payment-receipt-chain `agentWallet` binding.
export {
  buildErc8004Registration,
  validateErc8004Registration,
  toRegistrationJson,
  canonicalAgentId,
} from "./erc8004-registration.js";
export type {
  Erc8004Registration,
  Erc8004RegistrationInput,
  Erc8004Service,
  Erc8004Trust,
  Erc8004X402Support,
} from "./erc8004-registration.js";
