/**
 * ToolRegistryImpl — in-memory reference implementation of the
 * `ToolRegistry` contract. CC host overrides this with an OTel-traced
 * version (src/tools/registry.ts) that implements the same contract.
 */

import type { z } from "zod";
import type {
  AgentTool,
  MCPToolDefinition,
  ToolRegistry,
  ToolResult,
} from "./types.js";
import { isValidToolName } from "./types.js";
import { zodToJsonSchema } from "./zod-to-json-schema.js";

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register<T extends z.ZodTypeAny>(tool: AgentTool<T>): ToolResult<void> {
    if (!isValidToolName(tool.name)) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: `Invalid tool name "${tool.name}" — must be lowercase snake_case (a-z0-9_), 1-63 chars, starting with a letter`,
          toolName: tool.name,
        },
      };
    }

    if (this.tools.has(tool.name)) {
      return {
        ok: false,
        error: {
          code: "duplicate_name",
          message: `Tool "${tool.name}" is already registered`,
          toolName: tool.name,
        },
      };
    }

    this.tools.set(tool.name, tool as unknown as AgentTool);
    return { ok: true, data: undefined };
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  listMCPDefinitions(): MCPToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.parameters),
    }));
  }

  get size(): number {
    return this.tools.size;
  }

  clear(): void {
    this.tools.clear();
  }

  async execute(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Unknown tool: ${name}`,
          toolName: name,
        },
      };
    }

    const parseResult = tool.parameters.safeParse(args);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        ok: false,
        error: {
          code: "validation_failed",
          message: `Validation failed for tool "${name}": ${issues}`,
          toolName: name,
        },
      };
    }

    try {
      const data = await tool.execute(parseResult.data);
      return { ok: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "execution_failed",
          message: `Tool "${name}" execution failed: ${message}`,
          toolName: name,
        },
      };
    }
  }
}
