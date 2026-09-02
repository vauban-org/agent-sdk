/**
 * tests/mcp-subpath.test.ts
 *
 * Sprint-563: B5 — MCP subpath @vauban-org/agent-sdk/mcp.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { skillRegistryToMCPServer } from "../src/mcp/index.js";
import type { SkillRegistry } from "../src/orchestration/ooda/skills.js";
import type { Skill } from "../src/orchestration/ooda/skills.js";

function makeRegistry(): SkillRegistry {
  const brainQuery: Skill = {
    name: "brain_query",
    inputSchema: z.object({
      query: z.string(),
      limit: z.number().optional(),
    }),
    async execute(input) {
      const i = input as { query: string; limit?: number };
      return { results: [`Found: ${i.query}`] };
    },
  };

  const sendNotify: Skill = {
    name: "send_notification",
    inputSchema: z.object({
      channel: z.string(),
      message: z.string(),
    }),
    async execute(input) {
      const i = input as { channel: string; message: string };
      return { sent: true, channel: i.channel };
    },
  };

  const noSchema: Skill = {
    name: "no_schema",
    inputSchema: undefined as unknown as Skill["inputSchema"],
    async execute() {
      return { ok: true };
    },
  };

  return { brain_query: brainQuery, send_notification: sendNotify, no_schema: noSchema };
}

describe("skillRegistryToMCPServer", () => {
  it("converts skills to MCP tool definitions", () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test-agent",
      version: "1.0.0",
    });

    expect(server.name).toBe("test-agent");
    expect(server.version).toBe("1.0.0");
    expect(server.tools).toHaveLength(3);
    expect(server.tools.map((t) => t.name).sort()).toEqual([
      "brain_query",
      "no_schema",
      "send_notification",
    ]);
  });

  it("converts Zod schemas to JSON Schema input schemas", () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test",
      version: "1.0.0",
    });

    const brainQuery = server.tools.find((t) => t.name === "brain_query")!;
    expect(brainQuery.inputSchema.type).toBe("object");
    expect(brainQuery.inputSchema.properties.query).toBeDefined();
  });

  it("handleToolCall executes a skill and returns structured output", async () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test",
      version: "1.0.0",
    });

    const result = await server.handleToolCall("brain_query", {
      query: "what is Vauban?",
    });

    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("Found:");
  });

  it("handleToolCall returns error for unknown tool", async () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test",
      version: "1.0.0",
    });

    const result = await server.handleToolCall("nonexistent", {});
    expect(result.content[0]!.text).toContain("Unknown tool");
  });

  it("handleToolCall validates Zod input and returns error on invalid args", async () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test",
      version: "1.0.0",
    });

    const result = await server.handleToolCall("brain_query", {});
    expect(result.content[0]!.text).toContain("Invalid arguments");
  });

  it("returns empty properties for skills without schemas", () => {
    const registry = makeRegistry();
    const server = skillRegistryToMCPServer(registry, {
      name: "test",
      version: "1.0.0",
    });

    const noSchema = server.tools.find((t) => t.name === "no_schema")!;
    expect(noSchema.inputSchema.properties).toEqual({});
  });
});
