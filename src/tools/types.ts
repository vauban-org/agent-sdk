/**
 * Tool registry contract — shared types used by AgentLoop and SdkAgentLoop.
 *
 * This is the single source of truth for the tool surface. Concrete
 * registries (in-memory, CC-traced, remote-proxy) all implement
 * `ToolRegistry` defined here.
 */

import type { z } from "zod";
import type { SdkCapability } from "../permissions/sdk-permissions.js";

// ─── AgentTool ─────────────────────────────────────────────────────────────

/**
 * An agent tool: named capability with typed parameters and async handler.
 * The Zod schema doubles as runtime validator AND MCP inputSchema generator.
 *
 * Capability annotations (`capability`, `mcpScopes`, `dangerous`) are read
 * by SdkAgentLoop for permission enforcement and HITL gating. They are
 * ignored by the minimal AgentLoop (which only looks at `dangerous`).
 */
export interface AgentTool<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique tool name (snake_case, e.g. "query_knowledge"). */
  readonly name: string;
  /** Human-readable description for LLM tool-use. */
  readonly description: string;
  /** Zod schema for parameter validation. */
  readonly parameters: TParams;
  /** Async handler — receives validated params, returns unknown result. */
  readonly execute: (params: z.infer<TParams>) => Promise<unknown>;
  /** Capability surface required. Defaults to "mcp" in SdkAgentLoop. */
  readonly capability?: SdkCapability;
  /** Required MCP sub-scopes (e.g. ["brain:write"]). Only honoured when capability === "mcp". */
  readonly mcpScopes?: readonly string[];
  /** If true, HITL approval required before each call. */
  readonly dangerous?: boolean;
}

// ─── Tool execution result ─────────────────────────────────────────────────

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  toolName: string;
}

export type ToolErrorCode =
  | "not_found"
  | "validation_failed"
  | "execution_failed"
  | "duplicate_name";

// ─── MCP-compatible tool definition (JSON Schema output) ───────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Tool name validation ──────────────────────────────────────────────────

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_REGEX.test(name);
}

// ─── ToolRegistry contract ─────────────────────────────────────────────────

/**
 * Unified tool registry contract consumed by both AgentLoop (minimal) and
 * SdkAgentLoop (Anthropic-direct). Concrete implementations (CC, test doubles)
 * must implement every method.
 */
export interface ToolRegistry {
  /** Register a tool. Returns ok or a structured error. */
  register<T extends z.ZodTypeAny>(tool: AgentTool<T>): ToolResult<void>;

  /** Unregister a tool by name. Returns false if not found. */
  unregister(name: string): boolean;

  /** Get a registered tool by name. */
  get(name: string): AgentTool | undefined;

  /** Check if a tool is registered. */
  has(name: string): boolean;

  /** List all registered tool names. */
  listNames(): string[];

  /** List all tools as MCP-compatible definitions (JSON Schema). */
  listMCPDefinitions(): MCPToolDefinition[];

  /** Number of registered tools. */
  readonly size: number;

  /** Remove all registered tools. */
  clear(): void;

  /**
   * Execute a tool by name with raw (unvalidated) arguments.
   * Validates against the tool's Zod schema before invoking execute().
   */
  execute(name: string, args: unknown): Promise<ToolResult>;
}
