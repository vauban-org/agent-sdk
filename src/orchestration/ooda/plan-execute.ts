/**
 * Plan-and-Execute pattern — decompose a task in `decide`, execute step by step in `act`.
 *
 * decomposeTask() converts an orient output into a sequence of ordered steps.
 * executeStep() runs one step with tool access, producing a step result.
 *
 * @public
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface PlanStep {
  /** Step index (0-based). */
  index: number;
  /** Human-readable step description. */
  description: string;
  /** Tool expected to be used (optional hint). */
  tool?: string;
  /** Step-specific parameters. */
  params?: Record<string, unknown>;
}

/** @public */
export interface Plan {
  /** Overall goal. */
  goal: string;
  /** Ordered execution steps. */
  steps: PlanStep[];
  /** Estimated total cost in tokens. */
  estimatedTokens?: number;
}

/** @public */
export interface StepResult {
  stepIndex: number;
  status: "completed" | "failed" | "skipped";
  output?: unknown;
  error?: string;
  durationMs: number;
}

/** @public */
export interface PlanExecutionResult {
  plan: Plan;
  results: StepResult[];
  completedSteps: number;
  failedSteps: number;
  totalDurationMs: number;
}

// ─── Decompose ──────────────────────────────────────────────────────────────────

/**
 * Convert a task description into a structured plan.
 *
 * The `decomposer` function is an LLM call that takes a task description
 * and returns a Plan with ordered steps. Implementations should use
 * structured output (Zod schema) for reliable parsing.
 * @public
 */
export async function decomposeTask(
  task: string,
  decomposer: (task: string) => Promise<Plan>,
): Promise<Plan> {
  return decomposer(task);
}

// ─── Execute ────────────────────────────────────────────────────────────────────

/**
 * Execute a single plan step.
 *
 * Returns a StepResult with status, output, and timing.
 * @public
 */
export async function executeStep(
  step: PlanStep,
  executor: (step: PlanStep) => Promise<unknown>,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const output = await executor(step);
    return { stepIndex: step.index, status: "completed", output, durationMs: Date.now() - start };
  } catch (err) {
    return {
      stepIndex: step.index,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
