export { evalSuite, scoreTask } from "./harness.js";
export type {
  EvalStrategy,
  StrategyOutput,
  EvalTaskResult,
  EvalSuiteResult,
} from "./harness.js";
export {
  EVAL_DATASET_30,
  getTasksByCategory,
  getTasksByDifficulty,
} from "./datasets/index.js";
export type {
  EvalTask,
  EvalCategory,
  EvalDifficulty,
} from "./datasets/index.js";
export {
  cohenKappa,
  confusionMatrix,
  endToEndSuccess,
  meanPassAtK,
  meanPassHatK,
  passAtK,
  passHatK,
  successRate,
  toolCallCorrectness,
} from "./metrics.js";
export type {
  AttemptCounts,
  ConfusionMatrix,
  ToolCall,
  ToolCallScore,
} from "./metrics.js";
export { gateEval, runEval } from "./report.js";
export type {
  EvalCase,
  EvalReport,
  EvalThresholds,
  GateResult,
} from "./report.js";
export {
  formatGateReport,
  parseEvalDataset,
  runGateFromDataset,
} from "./gate-cli.js";
export type { GateRunResult } from "./gate-cli.js";
