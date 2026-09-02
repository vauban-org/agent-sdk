/**
 * ComplexAgent Template — Tier 3 (Supervisor-Worker + Plan-and-Execute + Debate).
 *
 * Promoted from forge/src/agents/shared/templates/complex-agent.ts (Vague 1.B.7).
 *
 * For agents that need multi-agent coordination, step-by-step planning,
 * and adversarial debate:
 *   - Orchestrateur Central, Treasury Agent, DevOps Agent, Security Auditor,
 *     Contract Reviewer.
 *
 * Pattern: observe → orient (LLM + Debate) → decide (Plan decomposition) →
 *          act (execute steps) → reflect (self-critique, optional) → feedback.
 *
 * Differences from Forge template:
 * - AgentDependencies removed — uses AgentFactoryDeps (SDK-native)
 * - buildSkills / createForgeAgent replaced by createAgentFromConfig (SDK)
 * - Forge-specific couplings (slackWebhookUrl, litellmUrl) removed
 * - hitlEscalationLevel wired to AgentFactoryConfig (not Forge-specific gate)
 *
 * @public @since 0.20.0
 */

import { createAgentFromConfig } from "../factory/agent-factory.js";
import type { AgentFactoryDeps } from "../factory/agent-factory.js";
import type { OODAAgent, OODAContext } from "../orchestration/ooda/types.js";
import type { OutcomeRecord, RiskGuard, SessionGuard } from "../orchestration/ooda/types.js";

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * ComplexAgentOptions — typed configuration for Tier 3 agents.
 *
 * Type parameters chain OODA phase I/O:
 * - `TObs`      — observation output
 * - `TOrient`   — orientation output (after LLM + Debate)
 * - `TDecision` — decision output (plan decomposition)
 * - `TAction`   — action output (step execution result)
 * - `TFeedback` — feedback output
 *
 * @public
 */
export interface ComplexAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback> {
  /** Agent identifier (e.g. "treasury-agent"). */
  agentId: string;
  /** Agent semver string. */
  agentVersion?: string;
  /** Cycle interval in milliseconds. */
  intervalMs: number;
  /** Observe phase: read data from Brain/APIs (readOnly). */
  // biome-ignore lint/suspicious/noConfusingVoidType: OODA observe phase takes no input; void is the empty-arg type.
  observe: (_: void, ctx: OODAContext) => Promise<TObs>;
  /** Orient phase: LLM analysis + optional Multi-Agent Debate (readOnly). */
  orient: (obs: TObs, ctx: OODAContext) => Promise<TOrient>;
  /** Decide phase: plan decomposition + LLM routing. */
  decide: (orient: TOrient, ctx: OODAContext) => Promise<TDecision>;
  /**
   * Act phase: executeSteps with optional ReactLoop for tool-calling.
   * Set `hitlEscalationLevel` to gate this phase on HITL approval.
   */
  act: (decision: TDecision, ctx: OODAContext) => Promise<TAction>;
  /**
   * Optional reflect phase: self-critique with Reflexion memory.
   * When provided, runs between act and feedback.
   */
  reflect?: (input: TAction & { decision: TDecision }, ctx: OODAContext) => Promise<TFeedback>;
  /** Feedback phase: log outcome, archive to Brain. */
  feedback: (input: TAction & { decision?: TDecision }, ctx: OODAContext) => Promise<TFeedback>;
  /**
   * HITL escalation level for the act phase.
   * - "L2": async review before irreversible effects.
   * - "L3": synchronous HITL approval required (default).
   */
  hitlEscalationLevel?: "L2" | "L3";
  /** Optional session guards (e.g. market hours). Defaults to alwaysOn. */
  sessionGuards?: SessionGuard[];
  /** Optional risk guards (e.g. circuit breaker, budget). */
  riskGuards?: RiskGuard[];
  /** Optional outcome mapping for Economic Observer. */
  outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Tier 3 (complex, supervisor-worker, debate-capable) OODA agent.
 *
 * Boilerplate reduction vs. raw `createAgentFromConfig`:
 * - HITL wiring handled automatically when `hitlEscalationLevel` is set
 * - Optional `reflect` phase wired correctly between act and feedback
 * - Phase `type` codes and `readOnly` flags set automatically
 *
 * @example
 * ```ts
 * const agent = await createComplexAgent<Obs, Orient, Plan, ExecResult, Feedback>(deps, {
 *   agentId: "treasury-agent",
 *   intervalMs: 3_600_000,
 *   observe: async () => ({ balance: 1000, pendingTx: [] }),
 *   orient: async (obs) => ({ recommendation: "hold", risk: "low" }),
 *   decide: async (orient) => ({ steps: [{ action: "record", data: orient }] }),
 *   act: async (plan) => ({ stepsExecuted: plan.steps.length }),
 *   feedback: async (result) => ({ success: result.stepsExecuted > 0 }),
 *   hitlEscalationLevel: "L3",
 * });
 * await agent.start();
 * ```
 *
 * @public
 */
export async function createComplexAgent<TObs, TOrient, TDecision, TAction, TFeedback>(
  deps: AgentFactoryDeps,
  opts: ComplexAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback>,
): Promise<OODAAgent> {
  return createAgentFromConfig<unknown, TObs, TOrient, TDecision, TAction, TFeedback>(deps, {
    agentId: opts.agentId,
    agentVersion: opts.agentVersion ?? "0.1.0",
    intervalMs: opts.intervalMs,
    hitlEscalationLevel: opts.hitlEscalationLevel ?? "L3",
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
        hitlGate: opts.hitlEscalationLevel !== undefined,
        fn: opts.act,
      },
      ...(opts.reflect !== undefined
        ? {
            reflect: {
              type: "feedback" as const,
              readOnly: true,
              fn: opts.reflect,
            },
          }
        : {}),
      feedback: {
        type: "feedback",
        fn: opts.feedback as (input: TAction, ctx: OODAContext) => Promise<TFeedback>,
      },
    },
  });
}
