/**
 * Tool registry contract — shared types used by AgentLoop and SdkAgentLoop.
 *
 * This is the single source of truth for the tool surface. Concrete
 * registries (in-memory, CC-traced, remote-proxy) all implement
 * `ToolRegistry` defined here.
 */

import type { z } from "zod";
import type { SdkCapability } from "../permissions/sdk-permissions.js";

// ─── RiskVector ────────────────────────────────────────────────────────────

/**
 * 5-dimensional risk vector for tool classification.
 * All dimensions are normalised to [0, 1].
 *
 * Inspired by arXiv:2510.15739 (AURA) gamma-based agent risk scoring.
 * Weights for `riskScore()` are calibrated against EU AI Act Art. 14 (human
 * oversight obligations for high-risk AI systems).
 * @public
 */
export interface RiskVector {
  /** 0 = fully reversible (read-only), 1 = irreversible (e.g. rm -rf). */
  reversibility: number;
  /** 0 = single isolated file, 1 = global system / cross-product. */
  blastRadius: number;
  /** 0 = public data, 1 = secrets / PII. */
  dataSensitivity: number;
  /** 0 = no external call, 1 = network call to unknown endpoint. */
  externalSideEffect: number;
  /**
   * Classifier confidence in the above scores.
   * 0 = uncertain (treat conservatively), 1 = fully confident.
   * Low confidence increases the aggregate risk score.
   */
  confidence: number;
}

/**
 * Weighted aggregate risk score in [0, 1].
 *
 * Default weights bias toward reversibility + blast radius per EU AI Act
 * Art. 14 oversight requirements. Callers may override individual weights;
 * unspecified dimensions inherit the defaults.
 *
 * Note: `confidence` contributes as `(1 - v.confidence)` so that uncertain
 * classifications raise, not lower, the aggregate risk.
 * @public
 */
export function riskScore(v: RiskVector, weights?: Partial<RiskVector>): number {
  const w: RiskVector = {
    reversibility: 0.3,
    blastRadius: 0.25,
    dataSensitivity: 0.2,
    externalSideEffect: 0.2,
    confidence: 0.05,
    ...weights,
  };
  return (
    v.reversibility * w.reversibility +
    v.blastRadius * w.blastRadius +
    v.dataSensitivity * w.dataSensitivity +
    v.externalSideEffect * w.externalSideEffect +
    (1 - v.confidence) * w.confidence // low confidence = higher risk
  );
}

/**
 * Bridge for the legacy `dangerous: boolean` flag.
 *
 * `dangerous: true`  → high-risk vector (reversibility 0.9, blast 0.7, …).
 * `dangerous: false` → low-risk vector (read-like defaults).
 * `dangerous: undefined` → same as false.
 *
 * Preserved for backward compatibility; prefer explicit `RiskVector` on new tools.
 * @public
 */
export function dangerousToRiskVector(dangerous?: boolean): RiskVector {
  return dangerous
    ? {
        reversibility: 0.9,
        blastRadius: 0.7,
        dataSensitivity: 0.5,
        externalSideEffect: 0.5,
        confidence: 0.5,
      }
    : {
        reversibility: 0.1,
        blastRadius: 0.1,
        dataSensitivity: 0.1,
        externalSideEffect: 0.1,
        confidence: 0.95,
      };
}

// ─── AgentTool ─────────────────────────────────────────────────────────────

/**
 * An agent tool: named capability with typed parameters and async handler.
 * The Zod schema doubles as runtime validator AND MCP inputSchema generator.
 *
 * Capability annotations (`capability`, `mcpScopes`, `dangerous`, `risk`) are
 * read by SdkAgentLoop for permission enforcement and HITL gating. They are
 * ignored by the minimal AgentLoop (which only looks at `dangerous`).
 *
 * Risk classification: prefer explicit `risk: RiskVector` on new tools.
 * The legacy `dangerous: boolean` flag is still honoured; when both are
 * present, `risk` takes precedence for scoring and `dangerous` is kept for
 * backward-compatible HITL gating.
 * @public
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
  /**
   * Legacy risk flag. If true, HITL approval required before each call.
   * Preserved for backward compatibility — new tools should use `risk` instead.
   * Use `dangerousToRiskVector(dangerous)` to synthesise a `RiskVector` from this flag.
   */
  readonly dangerous?: boolean;
  /**
   * 5-dimensional risk vector for fine-grained risk classification.
   * When present, use `riskScore(risk)` to compute the aggregate score.
   * Supersedes `dangerous` for scoring purposes; `dangerous` remains for HITL compat.
   */
  readonly risk?: RiskVector;
}

// ─── Tool execution result ─────────────────────────────────────────────────

/** @public */
export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: ToolError };

/** @public */
export interface ToolError {
  code: ToolErrorCode;
  message: string;
  toolName: string;
}

/** @public */
export type ToolErrorCode =
  | "not_found"
  | "validation_failed"
  | "execution_failed"
  | "duplicate_name";

// ─── MCP-compatible tool definition (JSON Schema output) ───────────────────

/** @public */
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

/** @public */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_REGEX.test(name);
}

// ─── ToolRegistry contract ─────────────────────────────────────────────────

/**
 * Unified tool registry contract consumed by both AgentLoop (minimal) and
 * SdkAgentLoop (Anthropic-direct). Concrete implementations (CC, test doubles)
 * must implement every method.
 * @public
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
