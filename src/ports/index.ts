/**
 * Ports — host-injected dependency interfaces consumed by agent plugins.
 *
 * The contract: agent packages depend ONLY on @vauban-org/agent-sdk and
 * never on the host application. Host concrete wiring happens at boot
 * via each agent's setXxxDeps() setter.
 */
export type { LoggerPort } from "./logger.js";
export { noopLogger } from "./logger.js";

export type {
  BrainPort,
  BrainEntry,
  BrainEntryInput,
  BrainQueryFilters,
} from "./brain.js";

export type { OutcomePort, AgentRunRef } from "./outcome.js";

export type { DbPort, DbClient } from "./db.js";
