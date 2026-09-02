/**
 * @vauban-org/agent-sdk/testing — Test stubs, contract suites, and integration harness.
 *
 * Sprint-455 + Sprint-565. Pattern borrowed from K8s CSI and Temporal SDK:
 * every host that implements a port (BrainPort, EventBusPort, EconomicObserver)
 * runs contract suites against its concrete impl to prove it meets the public contract.
 *
 * Test stubs are in-memory implementations for agent unit tests —
 * no Redis, no Brain HTTP, no Postgres required.
 *
 * Usage (vitest):
 *   import { describe, it, expect } from "vitest";
 *   import { brainPortContract, TestBrainPort, TestEventBus } from "@vauban-org/agent-sdk/testing";
 *
 *   brainPortContract(async () => {
 *     const port = new TestBrainPort();
 *     return { port, cleanup: async () => {} };
 *   });
 */

// Conformance suites (legacy)
export { brainPortConformance } from "./brain-conformance.js";
export type {
  BrainConformanceConfig,
  BrainOptionalCapability,
} from "./brain-conformance.js";
export { outcomePortConformance } from "./outcome-conformance.js";
export { loggerPortConformance } from "./logger-conformance.js";
export { dbPortConformance } from "./db-conformance.js";

export type { ConformanceRunner } from "./runner.js";

// Contract test suites — Sprint-565:0.4
export { brainPortContract } from "./contracts/brain-port.contract.js";
export type { BrainPortContractOptions } from "./contracts/brain-port.contract.js";
export { eventBusContract } from "./contracts/event-bus.contract.js";
export { economicObserverContract } from "./contracts/economic-observer.contract.js";

// Test stubs — Sprint-565:10
export { TestEventBus } from "./test-event-bus.js";
export { TestBrainPort } from "./test-brain-port.js";
export { TestChildAgentPort } from "./test-child-agent.js";
export { AgentIntegrationHarness } from "./integration-harness.js";
export type { HarnessAgent } from "./integration-harness.js";

// Chaos harness — Sprint-477
export {
  injectFailure,
  networkJitter,
  fullOutage,
  // Sprint-477: new BrainPort-aware helpers
  injectBrainFailure,
  wholeCircuit,
  exhaustResources,
} from "./chaos.js";
export type {
  FailureType,
  InjectFailureOptions,
  NetworkJitterOptions,
  OutageOptions,
  // Sprint-477: new option types
  InjectBrainFailureOptions,
  ExhaustResourcesOptions,
} from "./chaos.js";
