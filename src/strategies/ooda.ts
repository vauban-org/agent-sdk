/**
 * OODA strategy — Observe → Orient → Decide → Act → (Reflect) → Feedback.
 *
 * Adapter that maps the unified {@link AgentStrategy} contract onto the
 * existing {@link OODAAgentImpl}. The legacy OODA agent is feature-complete
 * (skill capture, telemetry, HITL gates, attestation, hot-reload config,
 * resource limits, run-step persistence) ; we re-use it verbatim rather than
 * re-port 1500 LOC.
 *
 * For users who want the full OODA lifecycle (sequential `while+sleep` loop,
 * `start`/`stop`/`streamCycle`), keep using `createOODAAgent` directly. This
 * strategy exposes the one-shot semantics needed by the unified `Agent.run`
 * surface : a single cycle, single user task.
 *
 * @public @experimental @since 2.0.0
 */

import type { AgentContext, AgentCycleResult, AgentStrategy } from "./types.js";

/**
 * Adapter that accepts a pre-built OODA cycle invoker. The Agent class is
 * responsible for constructing it ; the strategy simply executes it. This
 * keeps the strategy free of SDK-port imports (BrainPort, HitlPort, etc.).
 *
 * @public
 */
export interface OODACycleInvoker {
  /**
   * Run a single OODA cycle and return a strategy-shape result.
   *
   * Implementations typically wrap {@link OODAAgent.triggerCycle} +
   * collect tokens via {@link OODAAgentConfig.telemetry}.
   */
  invoke(ctx: AgentContext): Promise<AgentCycleResult>;
}

class OODAStrategy implements AgentStrategy {
  readonly name = "ooda" as const;
  constructor(private readonly invoker: OODACycleInvoker) {}

  async run(ctx: AgentContext): Promise<AgentCycleResult> {
    return this.invoker.invoke(ctx);
  }
}

/**
 * Factory for the OODA strategy. The Agent class injects an `OODACycleInvoker`
 * which wraps the existing `OODAAgentImpl`.
 *
 * @public @experimental @since 2.0.0
 */
export function createOODAStrategy(invoker: OODACycleInvoker): AgentStrategy {
  return new OODAStrategy(invoker);
}

/**
 * Sentinel invoker used when the Agent class has not been configured with
 * full OODA phases. Returns an error result without attempting any LLM call.
 *
 * @public
 */
export function createUnconfiguredOODAInvoker(): OODACycleInvoker {
  return {
    invoke: async (_ctx: AgentContext): Promise<AgentCycleResult> => ({
      finalMessage:
        "OODA strategy requires an OODAAgentConfig with full phase definitions. " +
        "Use createOODAAgent directly or pass `oodaPhases` to createAgent.",
      stopReason: "error",
      stepCount: 0,
      tokensUsed: { in: 0, out: 0 },
    }),
  };
}
