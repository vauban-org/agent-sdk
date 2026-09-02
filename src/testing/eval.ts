/**
 * Behavioral eval framework — EvalScenario + runEval + LLM scorer.
 *
 * Sprint-563: B6 — EvalScenario + LLM scorer + Vitest integration.
 *
 * Setup an agent scenario with assertions on the output events.
 * Optionally score the result with an LLM judge.
 * Integrates with Vitest for regression gating in CI.
 */

import type { CycleEvent, OODAAgent } from "../orchestration/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvalScenario {
  /** Scenario name (shown in test output). */
  name: string;
  /** Agent to evaluate. */
  agent: OODAAgent;
  /** Optional setup hook — runs before triggerCycle. */
  setup?: () => Promise<void>;
  /** Assertions on the streamed events. Return true if pass, false if fail. */
  assertions?: (events: CycleEvent[]) => boolean | Promise<boolean>;
  /** Expected cycle status. */
  expectedStatus?: "succeeded" | "failed" | "skipped";
  /** Minimum score from LLM judge (0-100). Only checked if llmScorer is set. */
  minScore?: number;
}

export interface EvalResult {
  name: string;
  passed: boolean;
  events: CycleEvent[];
  status: string;
  assertionFailure?: string;
  llmScore?: number;
  durationMs: number;
}

export interface EvalSuite {
  results: EvalResult[];
  passed: number;
  failed: number;
  total: number;
}

export interface LLMScorer {
  score(events: CycleEvent[], scenario: EvalScenario): Promise<number>;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run a single eval scenario. Triggers one cycle via streamCycle() and
 * validates assertions + optional LLM scorer.
 */
export async function runEval(
  scenario: EvalScenario,
  opts?: { llmScorer?: LLMScorer },
): Promise<EvalResult> {
  const start = Date.now();
  const events: CycleEvent[] = [];

  await scenario.setup?.();

  // Stream one cycle in dry-run mode
  const stream = scenario.agent.streamCycle({ dryRun: true });
  for await (const event of stream) {
    events.push(event);
  }

  const durationMs = Date.now() - start;

  let passed = true;
  let assertionFailure: string | undefined;

  // Status check
  const finalStatus = events.find((e) => e.type === "cycle_complete" || e.type === "cycle_error");
  const status =
    finalStatus?.type === "cycle_complete" ? (finalStatus as { status: string }).status : "error";

  if (scenario.expectedStatus && status !== scenario.expectedStatus) {
    passed = false;
    assertionFailure = `Expected status "${scenario.expectedStatus}", got "${status}"`;
  }

  // Custom assertions
  if (passed && scenario.assertions) {
    try {
      const result = await scenario.assertions(events);
      if (!result) {
        passed = false;
        assertionFailure = "Custom assertions failed";
      }
    } catch (err) {
      passed = false;
      assertionFailure = `Assertion error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // LLM scorer
  let llmScore: number | undefined;
  if (passed && opts?.llmScorer && scenario.minScore !== undefined) {
    llmScore = await opts.llmScorer.score(events, scenario);
    if (llmScore < scenario.minScore) {
      passed = false;
      assertionFailure = `LLM score ${llmScore} below minimum ${scenario.minScore}`;
    }
  }

  return {
    name: scenario.name,
    passed,
    events,
    status,
    assertionFailure,
    llmScore,
    durationMs,
  };
}

/**
 * Run a suite of eval scenarios. Returns aggregate results.
 */
export async function runEvalSuite(
  scenarios: EvalScenario[],
  opts?: { llmScorer?: LLMScorer },
): Promise<EvalSuite> {
  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runEval(scenario, opts));
  }

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    total: results.length,
  };
}

// ─── Simple pass/fail LLM scorer (no LLM dependency in core) ─────────────────

/**
 * A basic scorer that checks if the expected number of phase events occurred.
 * Production use should inject a real LLM judge via the LLMScorer interface.
 */
export function createPhaseCountScorer(expectedPhases: string[]): LLMScorer {
  return {
    async score(events: CycleEvent[]): Promise<number> {
      const phaseStarts = events.filter((e) => e.type === "phase_start");
      const matchCount = expectedPhases.filter((p) =>
        phaseStarts.some((e) => "phase" in e && e.phase === p),
      ).length;
      return Math.round((matchCount / expectedPhases.length) * 100);
    },
  };
}
