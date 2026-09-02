/**
 * AgentFactory — universal wiring of OODA agents from AgentFactoryConfig.
 *
 * Promoted from forge/src/agents/shared/agent-factory.ts (Vague 1.B.2).
 * Forge-specific business logic (Slack/Telegram HITL channels, buildRevenueSkills,
 * etc.) is NOT promoted — only the generic wiring pattern.
 *
 * Neutralized Forge couplings:
 * - HITL channels injected via deps.messaging (not hardcoded Telegram bot tokens)
 * - "FORGE.md" hardcoded string → parameterizable via loadAgentContext options
 * - Forge-specific metrics not promoted — consumers add via optional peer dep
 *
 * @public @since 0.17.0
 */

import { createOODAAgent } from "../orchestration/ooda/factory.js";
import { alwaysOn } from "../orchestration/ooda/guards/always-on.js";
import { waitForHITLApproval } from "../orchestration/ooda/hitl-gate.js";
import type {
  OODAAgent,
  OODAAgentConfig,
  OODAAgentDeps,
  OutcomeRecord,
  RiskGuard,
  SessionGuard,
} from "../orchestration/ooda/types.js";
import type { AgentDescriptor, AgentRegistryPort } from "../ports/agent-registry.js";
import type { MessagingChannelPort } from "../ports/messaging.js";
import type { AgentDependencies } from "../types/agent.js";

// ─── AgentFactoryDeps ─────────────────────────────────────────────────────────

/**
 * AgentDependencies extended with optional fields used by the factory.
 * Consumers may pass registry and messaging via this extension.
 *
 * @public
 */
export interface AgentFactoryDeps extends AgentDependencies {
  /** Optional AgentRegistryPort for auto-registration at boot. */
  readonly registry?: AgentRegistryPort;
  /** Optional messaging channel for HITL notifications. */
  readonly messaging?: MessagingChannelPort;
}

// ─── AgentFactoryConfig ───────────────────────────────────────────────────────

/**
 * Generic factory configuration. Type parameters chain OODA phase I/O.
 *
 * @public
 */
export interface AgentFactoryConfig<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
> {
  /** Agent identifier (e.g. "forge-revenue", "cc-sentinel"). */
  agentId: string;
  /** Agent semver string. */
  agentVersion: string;
  /** Cycle interval in milliseconds. */
  intervalMs: number;
  /** Default config merged with deps at boot. */
  defaults?: TConfig;
  /** OODA phase definitions. */
  phases: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>["phases"];
  /** Session guards (defaults to [alwaysOn()]). */
  sessionGuards?: SessionGuard[];
  /** Risk guards. */
  riskGuards?: RiskGuard[];
  /** Outcome mapping: feedback → outcome record (null skips recording). */
  outcomeMapping?: (feedback: TFeedback) => OutcomeRecord | null;
  /** HITL escalation level for actions requiring human review. */
  hitlEscalationLevel?: "L1" | "L2" | "L3";
  /**
   * Registry descriptor for auto-registration in AgentRegistryPort.
   * When provided AND deps.registry is set, the agent registers itself on boot.
   */
  registryDescriptor?: Omit<AgentDescriptor, "id"> & { product: string };
}

// ─── createAgentFromConfig ────────────────────────────────────────────────────

/**
 * Create an OODAAgent from a generic config + dependency bundle.
 *
 * Handles:
 * - Strict deps validation (SDK_STRICT_DEPS gate via createOODAAgent)
 * - Auto-registration in AgentRegistryPort when deps.registry is set
 * - HITL wiring via MessagingChannelPort (not Forge-specific Slack/Telegram)
 * - Resource limits with production-safe defaults
 *
 * @example
 * ```ts
 * const agent = await createAgentFromConfig(deps, {
 *   agentId: "my-agent",
 *   agentVersion: "1.0.0",
 *   intervalMs: 60_000,
 *   phases: { observe, orient, decide, act, feedback },
 * });
 * await agent.start();
 * ```
 *
 * @public
 */
export async function createAgentFromConfig<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
>(
  deps: AgentFactoryDeps,
  config: AgentFactoryConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>,
): Promise<OODAAgent> {
  const {
    agentId,
    agentVersion,
    intervalMs,
    phases,
    sessionGuards,
    riskGuards,
    outcomeMapping,
    hitlEscalationLevel = "L2",
    registryDescriptor,
  } = config;

  // 1. Auto-register in AgentRegistryPort if descriptor + registry provided
  if (registryDescriptor && deps.registry) {
    await deps.registry
      .register({
        id: `${registryDescriptor.product}:${agentId}`,
        ...registryDescriptor,
      })
      .catch((err: unknown) => {
        // Non-fatal: registration failure should not block agent boot
        deps.logger.warn(
          { err },
          `[${agentId}] AgentRegistry.register failed — agent may not appear in discovery`,
        );
      });
  }

  // 2. Build OODA deps bundle from AgentFactoryDeps
  const oodaDeps: Partial<OODAAgentDeps> = {
    eventBus: deps.eventBus,
    memory: deps.brain,
    messaging: deps.messaging,
  };

  // 3. Build HITL waiter if messaging channel available and in live mode
  let waitForHITL: OODAAgentConfig["waitForHITL"] | undefined;

  if (deps.messaging && deps.executionMode === "live") {
    const messaging = deps.messaging;
    const onTimeout = hitlEscalationLevel === "L3" ? "reject" : "approve";
    const timeoutMs = hitlEscalationLevel === "L3" ? 10 * 60_000 : 5 * 60_000;

    waitForHITL = async (ctx: {
      runId: string;
      stepId: string;
      payload: unknown;
    }) => {
      const decisionPayload = (ctx.payload as Record<string, unknown>) ?? {};

      // Skip HITL when act phase produced no actionable output
      const hasActions =
        (Array.isArray(decisionPayload.actions) &&
          (decisionPayload.actions as unknown[]).length > 0) ||
        (typeof decisionPayload.action === "string" &&
          (decisionPayload.action as string).length > 0) ||
        decisionPayload.estimatedCostCents !== undefined;

      if (!hasActions) return;

      const verdictPromise = waitForHITLApproval(
        deps.db,
        {
          runId: ctx.runId,
          agentId,
          decisionPayload,
          executionMode: deps.executionMode,
        },
        { onTimeout, timeoutMs },
      );

      // Fire-and-forget notification via messaging channel
      const costCents = decisionPayload.estimatedCostCents as number | undefined;
      const costLabel = costCents !== undefined ? ` — estimated cost: ${costCents}¢` : "";
      messaging
        .sendAlert(
          "warn",
          `[HITL] ${agentId} requires approval (${hitlEscalationLevel})`,
          `runId=${ctx.runId} stepId=${ctx.stepId}${costLabel}\n` +
            `Payload: ${JSON.stringify(decisionPayload).slice(0, 500)}`,
        )
        .catch((err: unknown) => {
          deps.logger.warn({ err }, `[${agentId}] HITL notification failed`);
        });

      const verdict = await verdictPromise;
      if (!verdict.approved) {
        throw new Error(verdict.rationale ?? "HITL: rejected");
      }
    };
  }

  // 4. Assemble OODAAgentConfig
  const oodaConfig: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback> = {
    agentId,
    agentVersion,
    intervalMs,
    executionMode: deps.executionMode,
    config: config.defaults,
    db: deps.db,
    logger: deps.logger,
    skills: deps.skills,
    deps: oodaDeps as OODAAgentDeps,
    phases,
    sessionGuards: sessionGuards ?? [alwaysOn()],
    riskGuards: riskGuards ?? [],
    outcomeMapping,
    resourceLimits: { phaseTimeoutMs: 300_000, maxStepsPerCycle: 20 },
    waitForHITL,
  };

  // 5. Create and return agent
  return createOODAAgent(oodaConfig);
}
