/**
 * @vauban-org/agent-sdk — Counterfactual replay module public API.
 *
 * OFFLINE TOOL. NOT a centerpiece. Use for ex-post analysis only —
 * never wire into live runtime.
 *
 * @module counterfactual
 */

export {
  replayCounterfactual,
  InvalidStrategyNameError,
} from "./replay-with-alt.js";

export type {
  ComputeStrategyName,
  CounterfactualOptions,
  CounterfactualResult,
  CounterfactualReplayContext,
} from "./replay-with-alt.js";
