/**
 * tests/agent-card-a2a.test.ts
 *
 * Sprint-563: B8 — AgentCard A2A v1.2 + Signed Agent Cards.
 */

import { describe, expect, it } from "vitest";
import { toAgentCard, validateAgentCard } from "../src/registry/agent-card.js";

const descriptor = {
  agentId: "market-radar",
  name: "Market Radar",
  description: "Monitors market conditions for trading signals",
  version: "1.2.3",
  capabilities: ["streaming", "stateTransitionHistory"],
};

const skills = [
  {
    name: "check_price",
    description: "Get current price of a token",
    inputSchema: { type: "object", properties: { token: { type: "string" } } },
    outputSchema: { type: "object", properties: { price: { type: "number" } } },
    tags: ["trading", "price"],
  },
  {
    name: "get_market_sentiment",
    description: "Analyze market sentiment",
    tags: ["sentiment"],
  },
];

describe("toAgentCard", () => {
  it("creates a valid A2A v1.2 AgentCard", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
    });

    expect(card.protocolVersion).toBe("1.2");
    expect(card.name).toBe("Market Radar");
    expect(card.url).toBe("https://agents.vauban.tech/agents/market-radar");
    expect(card.version).toBe("1.2.3");
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]!.id).toBe("skill:check_price");
    expect(card.skills[1]!.id).toBe("skill:get_market_sentiment");
  });

  it("sets default capabilities when not provided", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
    });

    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
  });

  it("overrides capabilities when provided", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
      capabilities: { streaming: false },
    });

    expect(card.capabilities.streaming).toBe(false);
  });

  it("signs the card when signingKey is provided (CH8)", async () => {
    const signedPayloads: string[] = [];
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
      signingKey: {
        async sign(payload: string) {
          signedPayloads.push(payload);
          return `sig:${Buffer.from(payload).toString("base64").slice(0, 32)}`;
        },
      },
    });

    expect(card.signature).toBeDefined();
    expect(card.signature).toContain("sig:");
    expect(signedPayloads).toHaveLength(1);
    // Verify the signed payload contains the card identity
    expect(signedPayloads[0]).toContain("Market Radar");
  });

  it("no signature when signingKey omitted", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
    });

    expect(card.signature).toBeUndefined();
  });

  it("uses default provider when not specified", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
    });

    expect(card.provider).toBe("vauban");
  });
});

describe("validateAgentCard", () => {
  it("validates a complete card", async () => {
    const card = await toAgentCard(descriptor, skills, {
      baseUrl: "https://agents.vauban.tech",
    });

    const result = validateAgentCard(card);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails when name is empty", () => {
    const result = validateAgentCard({
      protocolVersion: "1.2",
      name: "",
      description: "desc",
      url: "https://example.com/agent",
      version: "1.0.0",
      capabilities: { streaming: true },
      skills: [{ id: "s1", name: "s", description: "d" }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("fails when url is not HTTPS", () => {
    const result = validateAgentCard({
      protocolVersion: "1.2",
      name: "test",
      description: "desc",
      url: "http://insecure.com",
      version: "1.0.0",
      capabilities: { streaming: true },
      skills: [{ id: "s1", name: "s", description: "d" }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("HTTPS"))).toBe(true);
  });

  it("fails when skills is empty", () => {
    const result = validateAgentCard({
      protocolVersion: "1.2",
      name: "test",
      description: "desc",
      url: "https://example.com",
      version: "1.0.0",
      capabilities: { streaming: true },
      skills: [],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skill"))).toBe(true);
  });
});
