/**
 * sdk-loop — Claude-native agent loop over `@anthropic-ai/sdk`.
 *
 * Parallel to minimal-loop (which runs over provider-router and supports
 * Anthropic + Groq + fallbacks). sdk-loop takes the Anthropic-direct path:
 * single provider, adaptive thinking, typed tool-use.
 *
 * Permissions are pinned at construction and enforced at tool-dispatch.
 * Tools declare a `capability` via the AgentToolCapabilityMarker; missing
 * markers default to `mcp` (safest).
 *
 * HITL gate: tools tagged `dangerous: true` route through an optional
 * ApprovalChannel before execution.
 *
 * @experimental — surface may move before 1.0.0.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { ApprovalChannel } from "../hitl/approval-channel.js";
import {
  agentSpan,
  getTracer,
  llmSpan,
  recordLlmUsage,
  recordToolResult,
  toolSpan,
} from "../tracking/gen-ai.js";
import {
  type SdkCapability,
  type SdkPermissions,
  permitsCapability,
  permitsMcpScopes,
} from "../permissions/sdk-permissions.js";
import type {
  CapabilityGate,
  CapabilityGateVerdict,
} from "../permissions/capability-gate.js";
import type { RenewalManager } from "../permissions/renewal-manager.js";

// ─── ToolRegistry contract ─────────────────────────────────────────────────

// The SDK loop uses the same unified ToolRegistry as the minimal loop.
// `SdkToolRegistry` is kept as an alias for backward compatibility.
import type { AgentTool, ToolRegistry } from "../tools/types.js";

export type SdkToolRegistry = ToolRegistry;
/** @deprecated Use AgentTool from "@vauban-org/agent-sdk" directly. */
export type SdkToolEntry = AgentTool;

// ─── Capability annotation on tools ────────────────────────────────────────

export interface AgentToolCapabilityMarker {
  /** Capability surface this tool requires. Defaults to "mcp". */
  capability?: SdkCapability;
  /** Required MCP sub-scopes (e.g. ["brain:write"]). Only honoured when capability === "mcp". */
  mcpScopes?: readonly string[];
  /** If true, HITL approval required before each call. */
  dangerous?: boolean;
}

// ─── Config & result types ─────────────────────────────────────────────────

export interface SdkAgentLoopConfig {
  /** Stable agent identifier (e.g. "tester"). */
  agentId: string;
  /** Semver or git-sha tag for provenance. */
  agentVersion: string;
  /** System prompt; kept stable across turns for prompt-cache reuse. */
  systemPrompt: string;
  /** Anthropic SDK client — injected so tests can stub. */
  client: Anthropic;
  /** Model id (default: claude-opus-4-7). */
  model?: string;
  /** Max tokens per response. Default 16_000. */
  maxTokens?: number;
  /** Per-worker permissions — pinned at boot from JWT scopes. */
  permissions: SdkPermissions;
  /** Tool registry, filtered at dispatch through `permissions`. */
  tools: SdkToolRegistry;
  /** Optional HITL channel. Dangerous tools deny-closed when absent. */
  approvalChannel?: ApprovalChannel;
  /** Hard step ceiling; loop aborts with stopReason:"budget_exhausted". */
  maxSteps?: number;
  /** HITL poll interval (ms). Default 500. */
  approvalPollIntervalMs?: number;
  /** HITL default timeout (ms). Default 60_000. */
  approvalTimeoutMs?: number;
  /** Inject a tracer for tests. Defaults to the OTel singleton. */
  tracer?: Tracer;
  /**
   * Optional Biscuit capability gate. When provided, every tool call is
   * checked BEFORE dispatch — additionally to the pinned `cc:*` scope
   * filter. The result is the INTERSECTION: a call must pass both the
   * static permission projection and the dynamic Biscuit verdict.
   */
  capabilityGate?: CapabilityGate;
  /** Hook fired when the gate denies. Best-effort. */
  onToolDenied?: (event: {
    toolName: string;
    reason: string;
    budgetUsed: number;
  }) => void;
  /** Per-call cost (USD); accumulates across the loop for the gate. */
  costPerToolCallUsd?: number;
  /**
   * Optional auto-renewal manager. Loop calls `maybeRenew()` once per
   * LLM iteration before dispatching tools.
   */
  renewalManager?: RenewalManager;
}

export interface SdkAgentLoopRunResult {
  finalMessage: string;
  stopReason:
    | "complete"
    | "budget_exhausted"
    | "tool_denied"
    | "user_cancelled"
    | "max_tokens"
    | "error";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  traceId: string;
}

// ─── Implementation ────────────────────────────────────────────────────────

class SdkAgentLoopImpl {
  private readonly config: Required<
    Omit<
      SdkAgentLoopConfig,
      | "approvalChannel"
      | "tracer"
      | "capabilityGate"
      | "onToolDenied"
      | "costPerToolCallUsd"
      | "renewalManager"
    >
  > & {
    approvalChannel?: ApprovalChannel;
    tracer: Tracer;
    capabilityGate?: CapabilityGate;
    onToolDenied?: SdkAgentLoopConfig["onToolDenied"];
    costPerToolCallUsd: number;
    renewalManager?: RenewalManager;
  };

  constructor(config: SdkAgentLoopConfig) {
    this.config = {
      agentId: config.agentId,
      agentVersion: config.agentVersion,
      systemPrompt: config.systemPrompt,
      client: config.client,
      model: config.model ?? "claude-opus-4-7",
      maxTokens: config.maxTokens ?? 16_000,
      permissions: config.permissions,
      tools: config.tools,
      approvalChannel: config.approvalChannel,
      maxSteps: config.maxSteps ?? 25,
      approvalPollIntervalMs: config.approvalPollIntervalMs ?? 500,
      approvalTimeoutMs: config.approvalTimeoutMs ?? 60_000,
      tracer: config.tracer ?? getTracer("vauban-agent-sdk"),
      capabilityGate: config.capabilityGate,
      onToolDenied: config.onToolDenied,
      costPerToolCallUsd: config.costPerToolCallUsd ?? 0,
      renewalManager: config.renewalManager,
    };
  }

  /** Expose the pinned permissions for introspection / logging. */
  get permissions(): SdkPermissions {
    return this.config.permissions;
  }

  async run(userMessage: string): Promise<SdkAgentLoopRunResult> {
    const rootSpan = agentSpan(this.config.tracer, {
      agentId: this.config.agentId,
      agentVersion: this.config.agentVersion,
      runId: cryptoRandomId(),
    });
    const traceId = rootSpan.spanContext().traceId;

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: userMessage },
    ];
    const toolParams = this.buildToolsParam();

    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;
    let finalMessage = "";
    let stopReason: SdkAgentLoopRunResult["stopReason"] = "complete";
    /** Cumulative tool-call cost (USD) — fed to the capability gate. */
    let budgetUsedUsd = 0;

    try {
      while (steps < this.config.maxSteps) {
        steps += 1;

        if (this.config.renewalManager) {
          try {
            await this.config.renewalManager.maybeRenew();
          } catch {
            /* swallow — verifier surfaces expiry on next call */
          }
        }

        const lSpan = llmSpan(this.config.tracer, {
          provider: "anthropic",
          model: this.config.model,
          maxTokens: this.config.maxTokens,
          messageCount: messages.length,
        });

        let response: Anthropic.Messages.Message;
        try {
          response = await this.config.client.messages.create({
            model: this.config.model,
            max_tokens: this.config.maxTokens,
            system: this.config.systemPrompt,
            messages,
            ...(toolParams.length > 0 ? { tools: toolParams } : {}),
          });
          recordLlmUsage(lSpan, {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            latencyMs: 0,
            finishReason: String(response.stop_reason ?? "unknown"),
          });
          lSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          lSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error)?.message,
          });
          lSpan.recordException(err as Error);
          throw err;
        } finally {
          if (lSpan.isRecording()) lSpan.end();
        }

        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;

        if (response.stop_reason === "max_tokens") {
          stopReason = "max_tokens";
          finalMessage = extractText(response.content);
          break;
        }

        const toolUses = response.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          finalMessage = extractText(response.content);
          stopReason = "complete";
          break;
        }

        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        let cancelled = false;

        for (const call of toolUses) {
          const verdict = await this.authoriseCall(call, budgetUsedUsd);
          if (verdict === "deny") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: "permission_denied",
            });
            stopReason = "tool_denied";
            cancelled = true;
            break;
          }
          if (verdict === "capability_denied") {
            // Biscuit gate denied (token expired, scope mismatch, budget).
            // Graceful: surface to LLM as a tool error, allow the loop to
            // continue. Halt only when ALL calls in this batch fail —
            // see `cancelled` flag; we keep going within this batch.
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: "capability_denied",
            });
            continue;
          }
          if (verdict === "cancelled") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content: "user_cancelled",
            });
            stopReason = "user_cancelled";
            cancelled = true;
            break;
          }

          budgetUsedUsd += this.config.costPerToolCallUsd;

          const tSpan = toolSpan(this.config.tracer, call.name, call.input);
          const exec = await this.config.tools.execute(call.name, call.input);
          recordToolResult(tSpan, {
            success: exec.ok,
            errorMessage: exec.ok ? undefined : exec.error.message,
          });
          tSpan.end();

          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: !exec.ok,
            content: exec.ok
              ? safeStringify(exec.data).slice(0, 2000)
              : `ERROR: ${exec.error.message}`,
          });
        }

        messages.push({ role: "user", content: toolResults });

        if (cancelled) break;
      }

      if (steps >= this.config.maxSteps && stopReason === "complete") {
        stopReason = "budget_exhausted";
      }

      rootSpan.setAttribute("gen_ai.agent.stop_reason", stopReason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return {
        finalMessage,
        stopReason,
        usage: { inputTokens, outputTokens },
        traceId,
      };
    } catch (err) {
      rootSpan.recordException(err as Error);
      rootSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message,
      });
      return {
        finalMessage: "",
        stopReason: "error",
        usage: { inputTokens, outputTokens },
        traceId,
      };
    } finally {
      rootSpan.end();
    }
  }

  // ─── Tool authorisation path ──────────────────────────────────────────

  private async authoriseCall(
    call: Anthropic.Messages.ToolUseBlock,
    budgetUsedUsd: number,
  ): Promise<"allow" | "deny" | "capability_denied" | "cancelled"> {
    const tool = this.config.tools.get(call.name);
    if (!tool) return "deny";

    const capability: SdkCapability = tool.capability ?? "mcp";
    if (!permitsCapability(this.config.permissions, capability)) return "deny";
    if (capability === "mcp" && tool.mcpScopes) {
      if (!permitsMcpScopes(this.config.permissions, tool.mcpScopes))
        return "deny";
    }

    // Biscuit capability gate — INTERSECTION with the cc:* projection.
    // The static `permissions` filter has already ruled out anything the
    // worker's JWT doesn't grant; the dynamic gate now verifies the
    // request against the agent's signed capability token.
    if (this.config.capabilityGate) {
      let verdict: CapabilityGateVerdict;
      try {
        verdict = await this.config.capabilityGate.verify({
          toolName: call.name,
          budgetUsed: budgetUsedUsd,
          mcpScopes: tool.mcpScopes,
        });
      } catch {
        verdict = { allowed: false, reason: "gate_error" };
      }
      if (!verdict.allowed) {
        try {
          this.config.onToolDenied?.({
            toolName: call.name,
            reason: verdict.reason,
            budgetUsed: budgetUsedUsd,
          });
        } catch {
          /* best-effort */
        }
        return "capability_denied";
      }
    }

    if (tool.dangerous) {
      if (!this.config.approvalChannel) return "deny";
      const approved = await this.awaitApproval(tool, call.input);
      return approved ? "allow" : "cancelled";
    }

    return "allow";
  }

  private async awaitApproval(
    tool: AgentTool,
    args: unknown,
  ): Promise<boolean> {
    const channel = this.config.approvalChannel;
    if (!channel) return false;
    const timeoutMs = this.config.approvalTimeoutMs;
    const pollMs = this.config.approvalPollIntervalMs;

    const requestId = await channel.send({
      agentId: this.config.agentId,
      action: tool.name,
      context: safeStringify(args),
      timeoutMs,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const verdict = await channel.poll(requestId);
      if (verdict !== null) return verdict.approved === true;
      await sleep(pollMs);
    }
    await channel.cancel(requestId).catch(() => {
      /* best-effort */
    });
    return false;
  }

  // ─── Tool schema projection (permissions-filtered) ────────────────────

  private buildToolsParam(): Anthropic.Messages.Tool[] {
    const out: Anthropic.Messages.Tool[] = [];
    for (const def of this.config.tools.listMCPDefinitions()) {
      const tool = this.config.tools.get(def.name);
      if (!tool) continue;
      const capability: SdkCapability = tool.capability ?? "mcp";
      if (!permitsCapability(this.config.permissions, capability)) continue;
      if (
        capability === "mcp" &&
        tool.mcpScopes &&
        !permitsMcpScopes(this.config.permissions, tool.mcpScopes)
      ) {
        continue;
      }
      out.push({
        name: def.name,
        description: def.description ?? "",
        input_schema: def.inputSchema as Anthropic.Messages.Tool.InputSchema,
      });
    }
    return out;
  }
}

// ─── Helpers (unexported) ─────────────────────────────────────────────────

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractText(
  content: readonly Anthropic.Messages.ContentBlock[],
): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
  } catch {
    return "[unserialisable]";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── PUBLIC SURFACE ───────────────────────────────────────────────────────

export { SdkAgentLoopImpl as SdkAgentLoop };
