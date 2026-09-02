/**
 * SimpleAgent Template — Tier 1 (rule-based, no LLM debate).
 *
 * Promoted from forge/src/agents/shared/templates/simple-agent.ts (Vague 1.B.7).
 *
 * For agents that don't need LLM reasoning, Reflexion, or supervisor-worker:
 *   - Validator Monitor, KPI Dashboard, deadLetterAgent, Support Tier 1,
 *     Invoice & Facturation, Staking/Validator Monitor.
 *
 * Pattern: observe → orient (rules) → decide (threshold-based) → act → feedback.
 *
 * Differences from Forge template:
 * - AgentDependencies removed — uses AgentFactoryDeps (SDK-native)
 * - buildSkills / createForgeAgent replaced by createAgentFromConfig (SDK)
 * - Forge-specific couplings (slackWebhookUrl, litellmUrl in skill wiring) removed
 *
 * @public @since 0.20.0
 */

import { createAgentFromConfig } from "../factory/agent-factory.js";
import type { AgentFactoryDeps } from "../factory/agent-factory.js";
import type { OODAAgent, OODAContext } from "../orchestration/ooda/types.js";
import type { OutcomeRecord, RiskGuard, SessionGuard } from "../orchestration/ooda/types.js";

// ─── Shared action type for rule-based agents ─────────────────────────────────

export interface SimpleAction {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface SimpleDecision {
  readonly actions: SimpleAction[];
  readonly rationale: string;
}

export interface SimpleExecutionResult {
  readonly executed: Array<{
    readonly type: string;
    readonly success: boolean;
    readonly details: string;
  }>;
}

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * SimpleAgentOptions — typed configuration for Tier 1 agents.
 *
 * Type parameters:
 * - `TContext`  — observation output type
 * - `TOrient`   — orientation output type
 * - `TFeedback` — feedback output type
 *
 * @public
 */
export interface SimpleAgentOptions<TContext, TOrient, TFeedback> {
  /** Agent identifier (e.g. "validator-monitor"). */
  agentId: string;
  /** Agent semver string. */
  agentVersion?: string;
  /** Cycle interval in milliseconds. */
  intervalMs: number;
  /** Observe phase: reads data from Brain/APIs (readOnly). */
  // biome-ignore lint/suspicious/noConfusingVoidType: OODA observe phase takes no input; void is the empty-arg type.
  observe: (_: void, ctx: OODAContext) => Promise<TContext>;
  /** Orient phase: rule-based analysis on observation (readOnly). */
  orient: (obs: TContext, ctx: OODAContext) => Promise<TOrient>;
  /**
   * Decide phase: threshold-based decision on orient output.
   * Returns a SimpleDecision with actions list and rationale.
   */
  decide: (orient: TOrient, ctx: OODAContext) => Promise<SimpleDecision>;
  /**
   * Act phase: executes actions declared by decide.
   */
  act: (decision: SimpleDecision, ctx: OODAContext) => Promise<SimpleExecutionResult>;
  /**
   * Feedback phase: log outcome, optionally archive to Brain.
   */
  feedback: (result: SimpleExecutionResult, ctx: OODAContext) => Promise<TFeedback>;
  /** Optional session guards (e.g. market hours). Defaults to alwaysOn. */
  sessionGuards?: SessionGuard[];
  /** Optional risk guards (e.g. circuit breaker). */
  riskGuards?: RiskGuard[];
  /** Optional outcome mapping for Economic Observer. */
  outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Tier 1 (simple, rule-based) OODA agent.
 *
 * Boilerplate reduction vs. raw `createAgentFromConfig`:
 * - No `readOnly` flags to specify manually (observe + orient always readOnly)
 * - No phase `type` codes to remember
 * - Strongly-typed phase chain enforced by TypeScript
 *
 * @example
 * ```ts
 * const agent = await createSimpleAgent<Observation, Orientation, Feedback>(deps, {
 *   agentId: "kpi-monitor",
 *   intervalMs: 300_000,
 *   observe: async () => ({ cpu: 0.42, memory: 0.8 }),
 *   orient: async (obs) => ({ critical: obs.memory > 0.9 }),
 *   decide: async (orient) => ({
 *     actions: orient.critical ? [{ type: "alert", payload: {} }] : [],
 *     rationale: orient.critical ? "Memory critical" : "All good",
 *   }),
 *   act: async (decision) => ({
 *     executed: decision.actions.map((a) => ({ type: a.type, success: true, details: "" })),
 *   }),
 *   feedback: async (result) => ({ actionsExecuted: result.executed.length }),
 * });
 * await agent.start();
 * ```
 *
 * @public
 */
export async function createSimpleAgent<TContext, TOrient, TFeedback>(
  deps: AgentFactoryDeps,
  opts: SimpleAgentOptions<TContext, TOrient, TFeedback>,
): Promise<OODAAgent> {
  return createAgentFromConfig<
    unknown,
    TContext,
    TOrient,
    SimpleDecision,
    SimpleExecutionResult,
    TFeedback
  >(deps, {
    agentId: opts.agentId,
    agentVersion: opts.agentVersion ?? "0.1.0",
    intervalMs: opts.intervalMs,
    sessionGuards: opts.sessionGuards,
    riskGuards: opts.riskGuards,
    outcomeMapping: opts.outcomeMapping,
    phases: {
      observe: {
        type: "observation",
        readOnly: true,
        fn: opts.observe,
      },
      orient: {
        type: "retrieval",
        readOnly: true,
        fn: opts.orient,
      },
      decide: {
        type: "decision",
        fn: opts.decide,
      },
      act: {
        type: "execution",
        fn: opts.act,
      },
      feedback: {
        type: "feedback",
        fn: opts.feedback,
      },
    },
  });
}
