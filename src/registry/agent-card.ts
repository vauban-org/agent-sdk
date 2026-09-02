/**
 * AgentCard — A2A v1.2 (Linux Foundation, 150+ orgs).
 *
 * Sprint-563: B8 — AgentCard + A2A v1.2 + Signed Agent Cards (CH8 activation).
 *
 * Converts a Vauban AgentDescriptor into an A2A v1.2-compliant AgentCard.
 * Signed AgentCards activate CH8: Trace.agentSignature is computed from
 * the agent's identity key.
 */

// ─── A2A v1.2 Agent Card types ───────────────────────────────────────────────

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface A2AAgentCard {
  /** Agent Card spec version. */
  protocolVersion: "1.2";
  /** Human-readable name. */
  name: string;
  /** Natural language description. */
  description: string;
  /** Globally unique agent identifier. */
  url: string;
  /** Provider/org name. */
  provider?: string;
  /** Agent version (semver). */
  version: string;
  /** IANA media type for default input (default: application/json). */
  defaultInputModes?: string[];
  /** IANA media type for default output. */
  defaultOutputModes?: string[];
  /** Agent capabilities (streaming, push, state history). */
  capabilities: A2AAgentCapabilities;
  /** Exposed skills. */
  skills: A2ASkill[];
  /** Optional signature (CH8 activation). */
  signature?: string;
}

// ─── Agent Card options ──────────────────────────────────────────────────────

export interface AgentCardOptions {
  /** Base URL for the agent (e.g. "https://agents.vauban.tech"). */
  baseUrl: string;
  /** Provider/organization name. */
  provider?: string;
  /** Capabilities override. */
  capabilities?: Partial<A2AAgentCapabilities>;
  /** Signing key for CH8 Signed Agent Cards. */
  signingKey?: {
    sign: (payload: string) => Promise<string>;
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Convert a Vauban AgentDescriptor into an A2A v1.2 AgentCard.
 *
 * Usage:
 *   import { toAgentCard } from "@vauban-org/agent-sdk";
 *   const card = await toAgentCard(descriptor, skills, { baseUrl: "https://agents.vauban.tech" });
 */
export async function toAgentCard(
  descriptor: {
    agentId: string;
    name: string;
    description: string;
    version: string;
    capabilities?: string[];
  },
  skills: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    tags?: string[];
  }>,
  opts: AgentCardOptions,
): Promise<A2AAgentCard> {
  const card: A2AAgentCard = {
    protocolVersion: "1.2",
    name: descriptor.name,
    description: descriptor.description,
    url: `${opts.baseUrl}/agents/${descriptor.agentId}`,
    provider: opts.provider ?? "vauban",
    version: descriptor.version,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      ...opts.capabilities,
    },
    skills: skills.map((s) => ({
      id: `skill:${s.name}`,
      name: s.name,
      description: s.description,
      tags: s.tags,
      inputSchema: s.inputSchema,
      outputSchema: s.outputSchema,
    })),
  };

  // CH8: Sign the card if a signing key is provided
  if (opts.signingKey) {
    const payload = JSON.stringify({
      name: card.name,
      url: card.url,
      version: card.version,
      skills: card.skills.map((s) => s.id).sort(),
    });
    card.signature = await opts.signingKey.sign(payload);
  }

  return card;
}

/**
 * Validate that an AgentCard has all required fields per A2A v1.2 spec.
 */
export function validateAgentCard(card: A2AAgentCard): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (card.protocolVersion !== "1.2") {
    errors.push("protocolVersion must be '1.2'");
  }
  if (!card.name || card.name.trim().length === 0) {
    errors.push("name is required");
  }
  if (!card.description || card.description.trim().length === 0) {
    errors.push("description is required");
  }
  if (!card.url || !card.url.startsWith("https://")) {
    errors.push("url must be a valid HTTPS URL");
  }
  if (!card.version) {
    errors.push("version is required");
  }
  if (!card.skills || card.skills.length === 0) {
    errors.push("at least one skill is required");
  }

  return { valid: errors.length === 0, errors };
}
