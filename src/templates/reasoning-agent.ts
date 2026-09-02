/**
 * ReasoningAgent Template — Tier 2 (LLM + Reflexion + Inner Monologue).
 *
 * Promoted from forge/src/agents/shared/templates/reasoning-agent.ts (Vague 1.B.7).
 *
 * For agents that need reasoning but not multi-agent debate or supervisor-worker:
 *   - CFO IA, Chief of Staff IA, Prospector, Lead Qualifier, Outreach Writer,
 *     Churn Predictor, Contract Generator.
 *
 * Pattern: observe → orient (LLM + Reflexion) → decide (LLM) →
 *          act → reflect (self-critique, optional) → feedback.
 *
 * Extended thinking (Anthropic): pass `thinkingBudget` to enable budget_tokens
 * in orient/decide phases via `deps.llm` with extended thinking support.
 *
 * Differences from Forge template:
 * - AgentDependencies removed — uses AgentFactoryDeps (SDK-native)
 * - buildSkills / createForgeAgent replaced by createAgentFromConfig (SDK)
 * - `thinkingBudget` is an SDK-native concept (Anthropic extended thinking)
 *   exposed via `ctx.deps.llm` metadata — no hardcoded model names here
 * - Forge-specific couplings (slackWebhookUrl, litellmUrl) removed
 *
 * @public @since 0.20.0
 */

import { createAgentFromConfig } from "../factory/agent-factory.js";
import type { AgentFactoryDeps } from "../factory/agent-factory.js";
import type { OODAAgent, OODAContext } from "../orchestration/ooda/types.js";
import type { OutcomeRecord, RiskGuard, SessionGuard } from "../orchestration/ooda/types.js";

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * ReasoningAgentOptions — typed configuration for Tier 2 agents.
 *
 * Type parameters chain OODA phase I/O:
 * - `TObs`      — observation output
 * - `TOrient`   — orientation output (after LLM + Reflexion)
 * - `TDecision` — decision output (LLM-powered)
 * - `TAction`   — action output
 * - `TFeedback` — feedback output
 *
 * @public
 */
export interface ReasoningAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback> {
  /** Agent identifier (e.g. "cfo-agent"). */
  agentId: string;
  /** Agent semver string. */
  agentVersion?: string;
  /** Cycle interval in milliseconds. */
  intervalMs: number;
  /**
   * Agent role description used in LLM prompts (system prompt context).
   * Example: "You are the CFO agent responsible for financial oversight."
   */
  agentRole: string;
  /**
   * Extended thinking budget in tokens (Anthropic extended thinking).
   * When set, phases should pass `thinkingBudget` to `deps.llm.complete()`
   * via the `metadata` field or a custom wrapper.
   *
   * Recommended: 1024–8192 for reasoning tasks.
   * Only effective when `deps.llm` is an AnthropicDirectAdapter with an
   * extended-thinking-capable model (claude-3-7-sonnet or newer).
   */
  thinkingBudget?: number;
  /** Observe phase: read data from Brain/APIs (readOnly). */
  // biome-ignore lint/suspicious/noConfusingVoidType: OODA observe phase takes no input; void is the empty-arg type.
  observe: (_: void, ctx: OODAContext) => Promise<TObs>;
  /** Orient phase: LLM-powered analysis + Reflexion memory (readOnly). */
  orient: (obs: TObs, ctx: OODAContext) => Promise<TOrient>;
  /** Decide phase: LLM-powered decision making. */
  decide: (orient: TOrient, ctx: OODAContext) => Promise<TDecision>;
  /** Act phase: execute decisions via skills. */
  act: (decision: TDecision, ctx: OODAContext) => Promise<TAction>;
  /**
   * Optional reflect phase: self-critique on the action (Reflexion pattern).
   * Strongly recommended for reasoning agents to improve over time.
   */
  reflect?: (input: TAction & { decision: TDecision }, ctx: OODAContext) => Promise<TFeedback>;
  /** Feedback phase: log outcome, archive to Brain. */
  feedback: (input: TAction & { decision?: TDecision }, ctx: OODAContext) => Promise<TFeedback>;
  /**
   * HITL escalation level.
   * - "L2": async review (default for reasoning agents).
   * - "L3": synchronous HITL approval.
   * When absent, no HITL gate is applied.
   */
  hitlEscalationLevel?: "L2" | "L3";
  /** Optional session guards. Defaults to alwaysOn. */
  sessionGuards?: SessionGuard[];
  /** Optional risk guards. */
  riskGuards?: RiskGuard[];
  /** Optional outcome mapping for Economic Observer. */
  outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Tier 2 (reasoning, LLM-powered, Reflexion-capable) OODA agent.
 *
 * Boilerplate reduction vs. raw `createAgentFromConfig`:
 * - `agentRole` and `thinkingBudget` surfaced as first-class options
 * - Optional `reflect` phase wired correctly between act and feedback
 * - Phase `type` codes and `readOnly` flags set automatically
 * - HITL wiring handled when `hitlEscalationLevel` is set
 *
 * The `agentRole` and `thinkingBudget` values are accessible in every phase
 * via closure — pass them to `buildOrientPrompt` or `deps.llm.complete()` as
 * needed in your phase implementations.
 *
 * @example
 * ```ts
 * const agent = await createReasoningAgent<Obs, Orient, Decision, Action, Feedback>(deps, {
 *   agentId: "cfo-agent",
 *   intervalMs: 3_600_000,
 *   agentRole: "You are the CFO agent. Analyze financial data and provide recommendations.",
 *   thinkingBudget: 4096,
 *   observe: async () => ({ revenue: 10000, expenses: 8000 }),
 *   orient: async (obs, ctx) => {
 *     const { system, user } = buildOrientPrompt({
 *       systemPrompt: ctx.config.agentRole ?? "",
 *       userContext: JSON.stringify(obs),
 *     });
 *     const response = await ctx.deps.llm?.complete({ messages: [
 *       { role: "system", content: system },
 *       { role: "user", content: user },
 *     ]});
 *     return parseStructuredOutput(response?.content ?? "{}");
 *   },
 *   decide: async (orient) => ({ recommendation: orient.recommendation }),
 *   act: async (decision) => ({ executed: true, decision }),
 *   feedback: async (result) => ({ success: result.executed }),
 * });
 * await agent.start();
 * ```
 *
 * @public
 */
export async function createReasoningAgent<TObs, TOrient, TDecision, TAction, TFeedback>(
  deps: AgentFactoryDeps,
  opts: ReasoningAgentOptions<TObs, TOrient, TDecision, TAction, TFeedback>,
): Promise<OODAAgent> {
  return createAgentFromConfig<unknown, TObs, TOrient, TDecision, TAction, TFeedback>(deps, {
    agentId: opts.agentId,
    agentVersion: opts.agentVersion ?? "0.1.0",
    intervalMs: opts.intervalMs,
    hitlEscalationLevel: opts.hitlEscalationLevel,
    sessionGuards: opts.sessionGuards,
    riskGuards: opts.riskGuards,
    outcomeMapping: opts.outcomeMapping,
    // Expose agentRole + thinkingBudget via config so phases can access them
    // via ctx.config (cast to ReasoningAgentConfig by the phase implementation)
    defaults: {
      agentRole: opts.agentRole,
      thinkingBudget: opts.thinkingBudget,
    },
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

// ─── Config shape (accessible in phases via ctx.config) ──────────────────────

/**
 * ReasoningAgentConfig — the shape of `ctx.config` for reasoning agents.
 * Cast `ctx.config` to this type in your phase implementations:
 *
 * ```ts
 * orient: async (obs, ctx) => {
 *   const cfg = ctx.config as ReasoningAgentConfig;
 *   const { system, user } = buildOrientPrompt({
 *     systemPrompt: cfg.agentRole,
 *     userContext: JSON.stringify(obs),
 *   });
 *   // ...
 * }
 * ```
 *
 * @public
 */
export interface ReasoningAgentConfig {
  /** System prompt role description for LLM calls. */
  readonly agentRole: string;
  /** Extended thinking budget in tokens (optional). */
  readonly thinkingBudget?: number;
}
