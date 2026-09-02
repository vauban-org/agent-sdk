/**
 * MCP subpath — @vauban-org/agent-sdk/mcp
 *
 * Sprint-563: B5 — Convert a Vauban SkillRegistry (Record<string, Skill>)
 * into MCP-compatible tool definitions + call handler.
 *
 * Peer dependency: @modelcontextprotocol/sdk >= 1.5.0 (optional).
 */

import type { SkillRegistry } from "../orchestration/ooda/skills.js";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface MCPServerOptions {
  name: string;
  version: string;
}

/**
 * Convert a Vauban SkillRegistry into MCP-compatible tool list + handler.
 */
export function skillRegistryToMCPServer(
  registry: SkillRegistry,
  opts: MCPServerOptions,
): {
  name: string;
  version: string;
  tools: MCPToolDefinition[];
  handleToolCall: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
} {
  const tools: MCPToolDefinition[] = [];

  for (const [name, skill] of Object.entries(registry)) {
    const inputSchema: MCPToolDefinition["inputSchema"] = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };

    // Try to extract JSON Schema from Zod if available
    if (skill.inputSchema && typeof skill.inputSchema === "object") {
      try {
        const zodSchema = skill.inputSchema as Record<string, unknown>;
        if (zodSchema.shape) {
          inputSchema.properties = {};
          for (const [key, def] of Object.entries(zodSchema.shape as Record<string, unknown>)) {
            inputSchema.properties[key] = {
              type: inferJsonSchemaType(def),
              description: `Parameter: ${key}`,
            };
          }
        }
      } catch {
        // Keep defaults
      }
    }

    tools.push({
      name,
      description: skill.name,
      inputSchema,
    });
  }

  return {
    name: opts.name,
    version: opts.version,
    tools,
    async handleToolCall(toolName: string, args: Record<string, unknown>) {
      const skill = registry[toolName];
      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
        };
      }

      try {
        // Validate input if schema available
        let input = args;
        if (skill.inputSchema) {
          try {
            input = (skill.inputSchema as { parse: (r: unknown) => unknown }).parse(args) as Record<
              string,
              unknown
            >;
          } catch (parseErr) {
            return {
              content: [{ type: "text" as const, text: `Invalid arguments: ${String(parseErr)}` }],
            };
          }
        }

        const result = await skill.execute(input, {
          isReplay: false,
          dryRunMocks: {},
          db: undefined as unknown as never,
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

function inferJsonSchemaType(def: unknown): string {
  if (!def || typeof def !== "object") return "string";
  const d = def as Record<string, unknown>;
  const innerDef = (d as { _def?: { typeName?: string } })._def;
  if (innerDef?.typeName) {
    switch (innerDef.typeName) {
      case "ZodString":
        return "string";
      case "ZodNumber":
        return "number";
      case "ZodBoolean":
        return "boolean";
      case "ZodArray":
        return "array";
      case "ZodObject":
        return "object";
      default:
        return "string";
    }
  }
  return "string";
}
