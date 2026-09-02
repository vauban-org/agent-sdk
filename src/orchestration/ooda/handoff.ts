/**
 * Multi-agent handoff — Agent → Agent execution with history forwarding.
 *
 * Sprint-563: B2 — Multi-agent handoff() + asAgentTool() + handoffChain anti-cycle.
 *
 * handoff() wraps AgentsClient.execute with history forwarding (messages[]).
 * handoffChain: string[] prevents infinite cycles (HandoffCycleError if agent
 *   appears twice in the chain).
 * asAgentTool(descriptor, client) → AgentTool capability for MCP consumption.
 */

import type { CycleEventV011, OODAContext } from "./types.js";

// ─── Handoff types ───────────────────────────────────────────────────────────

/** @public */
export interface HandoffOptions {
  /** Target agent ID to hand off to. */
  targetAgentId: string;
  /** Messages to forward (history). */
  messages: Array<{ role: string; content: string }>;
  /** Chain of agents that have already participated (anti-cycle). */
  handoffChain: string[];
  /** OODA context from the calling agent. */
  ctx: OODAContext;
}

/** @public */
export interface HandoffResult {
  /** The child run ID created in the target agent. */
  childRunId: string;
  /** The handoff chain including the target (for the child to use). */
  nextChain: string[];
  /** Whether the handoff was accepted. */
  accepted: boolean;
}

/** @public */
export class HandoffCycleError extends Error {
  constructor(agentId: string, chain: string[]) {
    super(
      `Handoff cycle detected: agent "${agentId}" already in chain [${chain.join(" → ")} → ${agentId}]. Aborting.`,
    );
    this.name = "HandoffCycleError";
  }
}

/** @public */
export interface AgentHandoffClient {
  execute(
    agentId: string,
    input: { messages: Array<{ role: string; content: string }>; handoffChain: string[] },
  ): Promise<{ runId: string }>;
}

/**
 * Execute a handoff to another agent. Forwards messages[] and checks for cycles.
 * Throws HandoffCycleError if the target agent is already in the chain.
 * @public
 */
export async function handoff(
  opts: HandoffOptions,
  client: AgentHandoffClient,
): Promise<HandoffResult> {
  const { targetAgentId, messages, handoffChain } = opts;

  if (handoffChain.includes(targetAgentId)) {
    throw new HandoffCycleError(targetAgentId, handoffChain);
  }

  const result = await client.execute(targetAgentId, {
    messages,
    handoffChain: [...handoffChain, targetAgentId],
  });

  return {
    childRunId: result.runId,
    nextChain: [...handoffChain, targetAgentId],
    accepted: true,
  };
}

/**
 * Build a CycleEventV011 'handoff_initiated' event.
 * @public
 */
export function handoffToEvent(
  targetAgentId: string,
  childRunId: string,
  handoffChain: string[],
  runId: string,
  cycleIndex: number,
): Extract<CycleEventV011, { type: "handoff_initiated" }> {
  return {
    type: "handoff_initiated",
    runId,
    cycleIndex,
    targetAgentId,
    childRunId,
    handoffChain,
    ts: Date.now(),
  };
}

/**
 * Convert an agent descriptor into an MCP-compatible AgentTool.
 * Tools exposed this way can be called by other agents via MCP.
 */
export interface AgentDescriptor {
  agentId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** @public */
export async function asAgentTool(
  descriptor: AgentDescriptor,
  client: AgentHandoffClient,
): Promise<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: {
    messages: Array<{ role: string; content: string }>;
    handoffChain?: string[];
  }) => Promise<{ runId: string }>;
}> {
  return {
    name: `agent_${descriptor.agentId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    description: `Handoff to agent: ${descriptor.name} — ${descriptor.description}`,
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Conversation history to forward to the agent",
        },
        handoffChain: {
          type: "array",
          items: { type: "string" },
          description: "Chain of agents that have already participated (anti-cycle)",
        },
      },
      required: ["messages"],
      additionalProperties: false,
    },
    async handler(input) {
      return client.execute(descriptor.agentId, {
        messages: input.messages,
        handoffChain: input.handoffChain ?? [],
      });
    },
  };
}
