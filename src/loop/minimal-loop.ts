/**
 * minimal-loop — AgentLoop for multi-provider routing (Anthropic + Groq cascade).
 *
 * PUBLIC SURFACE — exactly 5 exports (1 class, 4 type re-exports). Any
 * additional helpers MUST remain unexported.
 */

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
  type AgentBudgetState,
  type LogMessage,
  compactToolLog,
  createCoherenceDetector,
  emergencyContextSummary,
} from "../budget/budget-state.js";
import type {
  ProviderRouter,
  ProviderRouterResponse,
} from "../router/provider-router.js";
import type {
  CapabilityGate,
  CapabilityGateVerdict,
} from "../permissions/capability-gate.js";
import type { RenewalManager } from "../permissions/renewal-manager.js";

// ─── ToolRegistry contract ─────────────────────────────────────────────────

// Re-export the unified contract so legacy callers of
// `import { ToolRegistry } from "@vauban-org/agent-sdk"` keep working unchanged.
export type { ToolRegistry } from "../tools/types.js";
import type { ToolRegistry, ToolResult } from "../tools/types.js";

// ─── Types ────────────────────────────────────────────────────────────────

interface AgentLoopConfig {
  agentId: string;
  agentVersion: string;
  systemPrompt: string;
  provider: ProviderRouter;
  tools: ToolRegistry;
  budget: AgentBudgetState;
  approvalChannel?: ApprovalChannel;
  tracker?: {
    recordStep: (d: {
      inputTokens: number;
      outputTokens: number;
      toolCalls?: number;
      costUsd: number;
    }) => Promise<void>;
  };
  /** Inject a tracer for tests. Defaults to the singleton OTel tracer. */
  tracer?: Tracer;
  /** HITL poll interval (ms). Default 500. */
  approvalPollIntervalMs?: number;
  /** HITL default timeout (ms). Default 60_000. */
  approvalTimeoutMs?: number;
  /**
   * Optional Biscuit capability gate. When provided, every tool call is
   * checked against the gate BEFORE dispatch. Denied calls produce a
   * `tool_denied` event and a structured tool-result error; the loop
   * continues with the next call (no panic).
   */
  capabilityGate?: CapabilityGate;
  /**
   * Hook fired when the capability gate denies a tool call. Receives the
   * call name and the deny reason. Best-effort — exceptions are swallowed.
   */
  onToolDenied?: (event: {
    toolName: string;
    reason: string;
    budgetUsed: number;
  }) => void;
  /**
   * Coarse cost-per-call (USD). Default 0 (loop doesn't know LLM unit
   * cost). Hosts that want budget enforcement set this to a per-call
   * estimate; it accumulates across the loop and is passed to the gate.
   */
  costPerToolCallUsd?: number;
  /**
   * Optional auto-renewal. When provided, the loop calls `maybeRenew()`
   * once per LLM iteration (before tool dispatch). The manager debounces
   * and only re-issues when ≥80% of the token lifetime has elapsed.
   */
  renewalManager?: RenewalManager;
}

interface AgentLoopRunResult {
  finalMessage: string;
  stopReason:
    | "complete"
    | "budget_exhausted"
    | "incoherent"
    | "tool_denied"
    | "user_cancelled"
    | "error";
  budgetFinal: AgentBudgetState;
  traceId: string;
}

class AgentLoopImpl {
  private readonly config: AgentLoopConfig;
  private readonly tracer: Tracer;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.tracer = config.tracer ?? getTracer("vauban-agent-sdk");
  }

  async run(userMessage: string): Promise<AgentLoopRunResult> {
    const runId = cryptoRandomId();
    const rootSpan = agentSpan(this.tracer, {
      agentId: this.config.agentId,
      agentVersion: this.config.agentVersion,
      runId,
    });
    const traceId = rootSpan.spanContext().traceId;

    const log: LogMessage[] = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: userMessage },
    ];

    const coherence = createCoherenceDetector();
    const recentCalls: Array<{ name: string; args: unknown }> = [];
    let stepsWithoutTool = 0;
    let stopReason: AgentLoopRunResult["stopReason"] = "complete";
    let finalMessage = "";
    /** Cumulative tool-call cost across the loop (USD), for the gate. */
    let budgetUsedUsd = 0;

    try {
      while (true) {
        if (this.config.budget.stepCount >= this.config.budget.maxSteps) {
          stopReason = "budget_exhausted";
          break;
        }

        // Auto-renewal: best-effort, debounced inside the manager. A
        // failed renewal is non-fatal — the existing token may still be
        // valid; the gate will deny on the next call if it expired.
        if (this.config.renewalManager) {
          try {
            await this.config.renewalManager.maybeRenew();
          } catch {
            /* swallow — verifier will surface expiry on next call */
          }
        }

        // Compaction trigger.
        if (
          this.config.budget.stepCount > 0 &&
          this.config.budget.stepCount === this.config.budget.compactionTrigger
        ) {
          const before = this.config.budget.contextWindow.currentTokens;
          const compacted = compactToolLog(log);
          log.splice(0, log.length, ...compacted);
          rootSpan.addEvent("gen_ai.agent.compacted", {
            before_tokens: before,
            after_tokens: this.config.budget.contextWindow.currentTokens,
          });
        }

        // Emergency summary if context > 90% of max.
        const { contextWindow } = this.config.budget;
        if (
          contextWindow.maxTokens > 0 &&
          contextWindow.currentTokens >
            Math.floor(contextWindow.maxTokens * 0.9)
        ) {
          try {
            const summary = await emergencyContextSummary(
              log,
              async (prompt) => {
                const res = await this.config.provider.complete({
                  messages: [{ role: "user", content: prompt }],
                  maxTokens: 1024,
                });
                return res.content;
              },
              { recursion: false },
            );
            log.splice(0, log.length, {
              role: "system",
              content: `[context recap] ${summary}`,
            });
            contextWindow.currentTokens = estimateTokens(summary);
            rootSpan.addEvent("gen_ai.agent.emergency_summary", {
              tokens_after: contextWindow.currentTokens,
            });
          } catch (err) {
            rootSpan.addEvent("gen_ai.agent.emergency_summary_failed", {
              error: (err as Error)?.message ?? String(err),
            });
          }
        }

        // ─── LLM round-trip ─────────────────────────────────────────────
        const lSpan = llmSpan(this.tracer, {
          provider: "router",
          model: "auto",
          maxTokens: this.config.budget.tokensBudget.output,
          messageCount: log.length,
        });
        let response: ProviderRouterResponse;
        try {
          response = await this.config.provider.complete({
            messages: log.map((m) => ({ role: m.role, content: m.content })),
            maxTokens: this.config.budget.tokensBudget.output,
          });
          recordLlmUsage(lSpan, {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            latencyMs: response.latencyMs,
            finishReason: response.toolCalls.length > 0 ? "tool_use" : "stop",
          });
          lSpan.setAttribute("gen_ai.system", response.provider);
          lSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          lSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error)?.message,
          });
          lSpan.recordException(err as Error);
          lSpan.end();
          throw err;
        } finally {
          if (lSpan.isRecording()) lSpan.end();
        }

        // Counters.
        this.config.budget.stepCount += 1;
        this.config.budget.tokensBudget.usedInput += response.usage.inputTokens;
        this.config.budget.tokensBudget.usedOutput +=
          response.usage.outputTokens;
        this.config.budget.contextWindow.currentTokens +=
          response.usage.inputTokens + response.usage.outputTokens;

        await this.config.tracker?.recordStep({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          toolCalls: response.toolCalls.length,
          costUsd: 0,
        });

        // ─── No tool call → assistant finalises. ────────────────────────
        if (response.toolCalls.length === 0) {
          log.push({ role: "assistant", content: response.content });
          finalMessage = response.content;
          stopReason = "complete";
          break;
        }

        log.push({ role: "assistant", content: response.content });
        stepsWithoutTool = 0;

        // ─── Execute each tool call sequentially. ───────────────────────
        let userCancelled = false;
        for (const tc of response.toolCalls) {
          recentCalls.push({ name: tc.name, args: tc.args });

          const tool = this.config.tools.get(tc.name);
          const isDangerous = tool?.dangerous === true;

          // ─── Capability gate (Biscuit) — pre-dispatch. ────────────────
          if (this.config.capabilityGate) {
            let verdict: CapabilityGateVerdict;
            try {
              verdict = await this.config.capabilityGate.verify({
                toolName: tc.name,
                budgetUsed: budgetUsedUsd,
                mcpScopes: tool?.mcpScopes,
              });
            } catch {
              verdict = { allowed: false, reason: "gate_error" };
            }
            if (!verdict.allowed) {
              try {
                this.config.onToolDenied?.({
                  toolName: tc.name,
                  reason: verdict.reason,
                  budgetUsed: budgetUsedUsd,
                });
              } catch {
                /* best-effort */
              }
              rootSpan.addEvent("gen_ai.tool.denied", {
                tool_name: tc.name,
                reason: verdict.reason,
              });
              log.push({
                role: "tool",
                content: `ERROR: capability_denied:${verdict.reason}`,
                toolName: tc.name,
              });
              continue; // Token expiry / scope deny is graceful — try next call.
            }
            // Account this call against the per-loop budget for the
            // verifier on subsequent calls.
            budgetUsedUsd += this.config.costPerToolCallUsd ?? 0;
          }

          if (isDangerous) {
            if (!this.config.approvalChannel) {
              stopReason = "user_cancelled";
              userCancelled = true;
              break;
            }
            const approved = await this.awaitApproval(tc);
            if (!approved) {
              stopReason = "user_cancelled";
              userCancelled = true;
              break;
            }
          }

          const tSpan = toolSpan(this.tracer, tc.name, tc.args);
          const result = await this.config.tools.execute(tc.name, tc.args);
          recordToolResult(tSpan, {
            success: result.ok,
            errorMessage: result.ok ? undefined : result.error.message,
          });
          tSpan.end();

          const toolContent = summariseToolResult(result);
          log.push({ role: "tool", content: toolContent, toolName: tc.name });
        }

        if (userCancelled) break;

        // ─── Coherence check on tool loop / stall. ──────────────────────
        const verdict = coherence.check(recentCalls, stepsWithoutTool);
        this.config.budget.coherenceScore = verdict.score;
        if (verdict.isLoop || verdict.isStall) {
          stopReason = "incoherent";
          rootSpan.addEvent("gen_ai.agent.incoherent", {
            is_loop: verdict.isLoop,
            is_stall: verdict.isStall,
          });
          break;
        }
      }

      rootSpan.setAttribute("gen_ai.agent.stop_reason", stopReason);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return {
        finalMessage,
        stopReason,
        budgetFinal: this.config.budget,
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
        budgetFinal: this.config.budget,
        traceId,
      };
    } finally {
      rootSpan.end();
    }
  }

  private async awaitApproval(tc: {
    name: string;
    args: unknown;
  }): Promise<boolean> {
    const channel = this.config.approvalChannel;
    if (!channel) return false;
    const timeoutMs = this.config.approvalTimeoutMs ?? 60_000;
    const pollMs = this.config.approvalPollIntervalMs ?? 500;

    const requestId = await channel.send({
      agentId: this.config.agentId,
      action: tc.name,
      context: safeStringify(tc.args),
      timeoutMs,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const verdict = await channel.poll(requestId);
      if (verdict !== null) {
        return verdict.approved === true;
      }
      await sleep(pollMs);
    }
    await channel.cancel(requestId).catch(() => {
      /* best-effort */
    });
    return false;
  }
}

// ─── Helpers (unexported) ─────────────────────────────────────────────────

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
  } catch {
    return "[unserialisable]";
  }
}

function summariseToolResult(r: ToolResult): string {
  if (r.ok) {
    return safeStringify(r.data).slice(0, 2000);
  }
  return `ERROR: ${r.error.message}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ─── PUBLIC SURFACE ───────────────────────────────────────────────────────

export { AgentLoopImpl as AgentLoop };
export type { AgentLoopRunResult, AgentLoopConfig };
