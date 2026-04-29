/**
 * @vauban-org/agent-sdk/testing — conformance test suites.
 *
 * Sprint-455. Pattern borrowed from K8s CSI and Temporal SDK:
 * every host that implements a port (BrainPort, OutcomePort, LoggerPort,
 * DbPort) runs these suites against its concrete impl to prove it meets
 * the public contract.
 *
 * Runner-agnostic: the caller injects `describe`, `it`, `expect` so the
 * suite works with vitest, jest, mocha, bun:test, etc.
 *
 * Usage (vitest):
 *   import { describe, it, expect } from "vitest";
 *   import { brainPortConformance } from "@vauban-org/agent-sdk/testing";
 *   import { buildHttpBrain } from "./my-brain.js";
 *
 *   brainPortConformance({
 *     describe, it, expect,
 *     factory: async () => buildHttpBrain({...}),
 *   });
 */

export { brainPortConformance } from "./brain-conformance.js";
export { outcomePortConformance } from "./outcome-conformance.js";
export { loggerPortConformance } from "./logger-conformance.js";
export { dbPortConformance } from "./db-conformance.js";

export type { ConformanceRunner } from "./runner.js";

// Chaos harness — Sprint-477
export {
  injectFailure,
  networkJitter,
  fullOutage,
} from "./chaos.js";
export type {
  FailureType,
  InjectFailureOptions,
  NetworkJitterOptions,
  OutageOptions,
} from "./chaos.js";
