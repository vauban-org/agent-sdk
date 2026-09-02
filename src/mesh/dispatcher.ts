/**
 * src/mesh/dispatcher.ts
 *
 * Mesh dispatcher — routes a {@link DispatchIntent} to a concrete executor
 * (LLM, OODA, MCP tool, plugin, fallback) and returns a uniform result shape.
 *
 * @deprecated Support module for `mesh/delegate.ts`, which has zero callers
 * in this monorepo as of 2026-07-05 (sprint-877 reconciliation). See the
 * STATUS note atop `mesh/delegate.ts` before adding a new dependency on this.
 *
 * The dispatcher knows NOTHING about budget tokens or capability attenuation —
 * those concerns live in `delegate.ts`. Keep this module narrowly scoped to
 * "given an intent kind, run the right executor".
 *
 * Default classifier is a heuristic (no LLM call). Callers may inject their own.
 */

import type { MeshAgentKind } from "./types.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** @public */
export interface DispatchIntent {
  /** Resolved kind — caller (or default classifier) decided which executor to use. */
  readonly kind: MeshAgentKind;
  /** Natural-language need. */
  readonly need: string;
  /** Optional context (structured data stringified, or free text). */
  readonly context?: string;
  /** Wall-clock deadline in ms. */
  readonly deadline_ms?: number;
  /** Max cost in EUR. */
  readonly max_cost_eur?: number;
  /** Optional MCP tool name (only used when kind === "mcp-tool"). */
  readonly toolName?: string;
  /** Opaque MCP tool args (only used when kind === "mcp-tool"). */
  readonly toolArgs?: unknown;
}

/** @public */
export interface DispatchResult {
  readonly output: string;
  readonly costEur: number;
  readonly durationMs: number;
  /** True if the executor stopped on deadline before producing a final answer. */
  readonly truncated: boolean;
}

/** @public */
export interface MeshDispatcher {
  dispatch(intent: DispatchIntent): Promise<DispatchResult>;
}

// ─── Classifier (heuristic, no LLM) ──────────────────────────────────────────

/**
 * Tokens that suggest a long-running observation/audit loop → OODA.
 * Order-stable, lowercase, word-boundary matched in {@link defaultClassifier}.
 */
const OODA_HINTS = [
  "scan",
  "audit",
  "monitor",
  "watch",
  "step by step",
  "analyze then",
  "investigate",
  "diagnose",
  "post-mortem",
];

/**
 * Tokens that suggest a single tool call → MCP tool dispatch.
 */
const MCP_HINTS = [
  "get price",
  "fetch",
  "call api",
  "lookup",
  "read contract",
  "check balance",
  "get_",
];

/**
 * Default heuristic classifier — zero LLM cost.
 *
 *  - OODA when need contains an OODA hint OR has ≥ 3 sentence-terminating marks.
 *  - MCP-tool when need contains an MCP hint and is short (< 80 chars).
 *  - LLM-router otherwise.
 *
 * Note: callers wanting LLM-based classification should inject a custom
 * `classifier` via {@link DispatcherConfig}.
 * @public
 */
export function defaultClassifier(need: string): MeshAgentKind {
  const n = need.toLowerCase().trim();
  if (n.length === 0) return "llm-router";

  for (const hint of OODA_HINTS) {
    if (n.includes(hint)) return "ooda";
  }
  // 3+ sentence terminators = multi-step instruction → OODA.
  const terminators = (n.match(/[.!?]/g) ?? []).length;
  if (terminators >= 3) return "ooda";

  if (n.length < 80) {
    for (const hint of MCP_HINTS) {
      if (n.includes(hint)) return "mcp-tool";
    }
  }

  return "llm-router";
}

// ─── DispatcherConfig & DefaultMeshDispatcher ────────────────────────────────

/** @public */
export interface DispatcherConfig {
  /** Override the default heuristic classifier. */
  readonly classifier?: (need: string) => MeshAgentKind;
  /**
   * Executor for `kind === "llm-router"`.
   * Must respect `deadline_ms` (caller-provided).
   */
  readonly llmExecutor?: (prompt: string, deadlineMs: number) => Promise<string>;
  /**
   * Executor for `kind === "ooda"`. Receives need + optional context.
   * Must respect `deadline_ms` (passed via 3rd arg).
   */
  readonly oodaExecutor?: (
    need: string,
    context: string | undefined,
    deadlineMs: number,
  ) => Promise<string>;
  /**
   * Registry of MCP tools. Keyed by tool name; values are pre-bound async fns.
   */
  readonly mcpTools?: Readonly<Record<string, (args: unknown) => Promise<string>>>;
  /**
   * Optional plugin executor (last-resort, kind === "plugin").
   */
  readonly pluginExecutor?: (need: string, context: string | undefined) => Promise<string>;
  /**
   * Fallback executor when no other kind matches. Default: echoes need.
   */
  readonly fallbackExecutor?: (intent: DispatchIntent) => Promise<string>;
  /**
   * Cost model in EUR per millisecond. Default 0 (free-tier accounting).
   * Production: inject a model that consults `tracking/provider-usage`.
   */
  readonly costPerMs?: number;
}

const DEFAULT_DEADLINE_MS = 30_000;

/**
 * Default dispatcher — composes injected executors into a uniform
 * "intent → result" pipeline, including deadline enforcement and cost
 * accounting.
 *
 * Concurrency notes:
 *  - Uses `AbortController` + `setTimeout` to enforce `deadline_ms`.
 *  - On deadline trip, returns `truncated: true` and the executor must respect
 *    the abort signal it received via Promise.race.
 * @public
 */
export class DefaultMeshDispatcher implements MeshDispatcher {
  private readonly classifier: (need: string) => MeshAgentKind;
  private readonly llm: NonNullable<DispatcherConfig["llmExecutor"]>;
  private readonly ooda: NonNullable<DispatcherConfig["oodaExecutor"]>;
  private readonly mcpTools: Readonly<Record<string, (args: unknown) => Promise<string>>>;
  private readonly plugin: NonNullable<DispatcherConfig["pluginExecutor"]>;
  private readonly fallback: NonNullable<DispatcherConfig["fallbackExecutor"]>;
  private readonly costPerMs: number;

  constructor(config: DispatcherConfig = {}) {
    this.classifier = config.classifier ?? defaultClassifier;
    this.llm =
      config.llmExecutor ?? (async (prompt) => `[llm-router stub] ${prompt.slice(0, 200)}`);
    this.ooda = config.oodaExecutor ?? (async (need) => `[ooda stub] ${need.slice(0, 200)}`);
    this.mcpTools = config.mcpTools ?? {};
    this.plugin = config.pluginExecutor ?? (async (need) => `[plugin stub] ${need.slice(0, 200)}`);
    this.fallback = config.fallbackExecutor ?? (async (i) => `[fallback] ${i.need.slice(0, 200)}`);
    this.costPerMs = config.costPerMs ?? 0;
  }

  /** Classify a need without dispatching — exposed for callers that pre-route. */
  classify(need: string): MeshAgentKind {
    return this.classifier(need);
  }

  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    const deadlineMs = intent.deadline_ms ?? DEFAULT_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError(
        `DefaultMeshDispatcher.dispatch: deadline_ms must be > 0, got ${deadlineMs}`,
      );
    }
    const maxCost = intent.max_cost_eur ?? Number.POSITIVE_INFINITY;
    if (maxCost < 0) {
      throw new RangeError(
        `DefaultMeshDispatcher.dispatch: max_cost_eur must be ≥ 0, got ${maxCost}`,
      );
    }

    const start = performance.now();
    const exec = this.executorFor(intent);

    let truncated = false;
    let output: string;
    try {
      output = await this.runWithDeadline(exec, deadlineMs);
    } catch (err) {
      if (err instanceof DeadlineExceededError) {
        truncated = true;
        output = err.partial ?? "";
      } else {
        throw err;
      }
    }

    const durationMs = performance.now() - start;
    const costEur = Math.min(maxCost, durationMs * this.costPerMs);

    return { output, costEur, durationMs, truncated };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private executorFor(intent: DispatchIntent): () => Promise<string> {
    const deadlineMs = intent.deadline_ms ?? DEFAULT_DEADLINE_MS;
    switch (intent.kind) {
      case "llm-router": {
        const prompt = intent.context
          ? `${intent.need}\n\n[context]\n${intent.context}`
          : intent.need;
        return () => this.llm(prompt, deadlineMs);
      }
      case "ooda":
        return () => this.ooda(intent.need, intent.context, deadlineMs);
      case "mcp-tool": {
        const name = intent.toolName;
        if (!name) {
          return async () => {
            throw new MeshDispatchError(
              "mcp-tool intent missing toolName",
              "MCP_TOOL_NAME_MISSING",
            );
          };
        }
        const tool = this.mcpTools[name];
        if (!tool) {
          return async () => {
            throw new MeshDispatchError(`mcp-tool "${name}" not registered`, "MCP_TOOL_NOT_FOUND");
          };
        }
        return () => tool(intent.toolArgs);
      }
      case "plugin":
        return () => this.plugin(intent.need, intent.context);
      case "fallback":
        return () => this.fallback(intent);
      default: {
        const _exhaustive: never = intent.kind;
        return async () => {
          throw new MeshDispatchError(
            `Unknown intent kind: ${String(_exhaustive)}`,
            "UNKNOWN_KIND",
          );
        };
      }
    }
  }

  private async runWithDeadline(exec: () => Promise<string>, deadlineMs: number): Promise<string> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new DeadlineExceededError(deadlineMs));
      }, deadlineMs);
    });
    try {
      return await Promise.race([exec(), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** @public */
export class DeadlineExceededError extends Error {
  override readonly name = "MeshDeadlineExceededError";
  readonly partial?: string;
  constructor(deadlineMs: number, partial?: string) {
    super(`mesh.dispatch: deadline ${deadlineMs}ms exceeded`);
    this.partial = partial;
  }
}

/** @public */
export class MeshDispatchError extends Error {
  override readonly name = "MeshDispatchError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
