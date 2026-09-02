/**
 * provider-router — Anthropic → Groq cascade for agent loops.
 *
 * Contract:
 *   1. Prefer Anthropic if configured; on rate-limit (429) or timeout, fall
 *      back to Groq. On both failing, invoke `queueRetryFn` (BullMQ owns
 *      retry scheduling) then throw.
 *   2. Normalize tool-call shape across providers to `{name, args:object}`.
 *      Anthropic returns `tool_use` blocks with parsed `input`; Groq returns
 *      OpenAI-style `tool_calls[].function.arguments` as a JSON string.
 *   3. `usage.inputTokens` / `usage.outputTokens` are always finite numbers.
 */

import Anthropic from "@anthropic-ai/sdk";
import { HttpError, fetchJson } from "../http/fetch-json.js";

/**
 * Zero-config bootstrap defaults. Concrete IDs required by the provider
 * clients — update alongside model releases (see vauban-gouvernance
 * model-selection.md model-ids-current marker). last-verified 2026-07-08.
 * Hosts SHOULD pass `opts.model.anthropic` / `opts.model.groq` explicitly;
 * these exist only so `createProviderRouter()` works out of the box.
 */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

// ─── Public contract ──────────────────────────────────────────────────────

/** @public */
export interface ProviderRouterRequest {
  messages: Array<{ role: string; content: string; toolName?: string }>;
  tools?: unknown[];
  maxTokens?: number;
}

/** @public */
export interface ProviderRouterResponse {
  content: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  latencyMs: number;
}

/**
 * Optional per-call streaming hook (session-dans-la-poche C2, sprint-1065
 * `t1-stream-deltas`). A provider that streams its transport MAY call
 * `onDelta` once per text chunk AS IT ARRIVES, before `complete()` resolves.
 * A provider that does not stream (or a step where streaming is unsafe —
 * e.g. a reasoning model whose thinking-block replay requires the
 * non-streaming transport) simply never calls it ; the caller falls back to
 * treating the resolved `content` as a single block. Never called with an
 * empty string. Tool-call argument fragments are NEVER surfaced through
 * `onDelta` — only assistant text.
 * @public
 */
export interface ProviderRouterCompleteOptions {
  onDelta?: (chunk: string) => void;
}

/** @public */
export interface ProviderRouter {
  complete(
    request: ProviderRouterRequest,
    opts?: ProviderRouterCompleteOptions,
  ): Promise<ProviderRouterResponse>;
}

export interface ProviderRouterOptions {
  preferAnthropic?: boolean;
  anthropicApiKey?: string;
  groqApiKey?: string;
  queueRetryFn?: (req: unknown) => Promise<void>;
  /**
   * Model per provider. Hosts SHOULD pass these explicitly — the router
   * falls back to `DEFAULT_ANTHROPIC_MODEL` / `DEFAULT_GROQ_MODEL` only
   * for zero-config bootstrap, and those defaults drift as new model
   * families ship.
   */
  model?: { anthropic?: string; groq?: string };
  /** Injected for tests — Anthropic SDK client. */
  anthropicClient?: AnthropicLike;
  /** Injected for tests — fetch used to call Groq. */
  fetchImpl?: typeof fetch;
}

// Narrow structural type so tests can inject a mock without pulling the full SDK.
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<unknown>;
  };
}

// ─── Error taxonomy ───────────────────────────────────────────────────────

/** @public */
export class ProviderRouterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderRouterError";
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────

/** @public */
export function createProviderRouter(opts?: ProviderRouterOptions): ProviderRouter {
  const preferAnthropic = opts?.preferAnthropic ?? true;
  const anthropicApiKey = opts?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const groqApiKey = opts?.groqApiKey ?? process.env.GROQ_API_KEY;
  const anthropicModel = opts?.model?.anthropic ?? DEFAULT_ANTHROPIC_MODEL;
  const groqModel = opts?.model?.groq ?? DEFAULT_GROQ_MODEL;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const anthropicClient: AnthropicLike | null =
    opts?.anthropicClient ??
    (anthropicApiKey
      ? (new Anthropic({ apiKey: anthropicApiKey }) as unknown as AnthropicLike)
      : null);

  const useAnthropic = preferAnthropic && anthropicClient !== null;
  if (preferAnthropic && anthropicClient === null) {
    console.info("[provider-router] Anthropic not configured, routing to Groq");
  }

  return {
    async complete(request) {
      let anthropicErr: unknown = null;

      if (useAnthropic && anthropicClient !== null) {
        try {
          return await callAnthropic(anthropicClient, request, anthropicModel);
        } catch (err) {
          anthropicErr = err;
          if (!isAnthropicFallbackEligible(err)) {
            throw new ProviderRouterError(
              `Anthropic call failed (non-retryable): ${(err as Error)?.message ?? String(err)}`,
              err,
            );
          }
          console.warn(
            `[provider-router] Anthropic failed (${classifyAnthropicErr(
              err,
            )}), falling back to Groq`,
          );
        }
      }

      if (!groqApiKey) {
        if (opts?.queueRetryFn) {
          await opts.queueRetryFn(request).catch(() => {
            /* queue best-effort */
          });
        }
        throw new ProviderRouterError(
          "All providers unavailable: Anthropic failed and Groq API key missing",
          anthropicErr,
        );
      }

      try {
        return await callGroq(fetchImpl, groqApiKey, request, groqModel);
      } catch (err) {
        console.warn("[provider-router] Groq failed, queueing retry");
        if (opts?.queueRetryFn) {
          await opts.queueRetryFn(request).catch(() => {
            /* queue best-effort */
          });
        }
        throw new ProviderRouterError(
          `All providers failed. Last error: ${(err as Error)?.message ?? String(err)}`,
          err,
        );
      }
    },
  };
}

// ─── Anthropic path ───────────────────────────────────────────────────────

async function callAnthropic(
  client: AnthropicLike,
  request: ProviderRouterRequest,
  model: string,
): Promise<ProviderRouterResponse> {
  const start = Date.now();

  const { system, messages } = splitAnthropicMessages(request.messages);

  const params: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 4096,
    messages,
  };
  if (system) params.system = system;
  if (request.tools && request.tools.length > 0) params.tools = request.tools;

  const raw = (await client.messages.create(params)) as {
    content?: Array<
      { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown }
    >;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  let text = "";
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  for (const block of raw.content ?? []) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, args: block.input });
    }
  }

  return {
    content: text,
    toolCalls,
    usage: {
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
    },
    provider: "anthropic",
    latencyMs: Date.now() - start,
  };
}

function splitAnthropicMessages(input: Array<{ role: string; content: string }>): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of input) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content });
    } else if (m.role === "tool") {
      // Collapse tool results into user messages for Anthropic simple path.
      messages.push({ role: "user", content: `[tool] ${m.content}` });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function classifyAnthropicErr(err: unknown): string {
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.status === 429) return "rate_limit_429";
  if (e?.status !== undefined && e.status >= 500) return `server_${e.status}`;
  if (e?.name === "AbortError" || /timeout/i.test(e?.message ?? "")) {
    return "timeout";
  }
  return "error";
}

function isAnthropicFallbackEligible(err: unknown): boolean {
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.status === 429) return true;
  if (e?.status !== undefined && e.status >= 500) return true;
  if (e?.name === "AbortError" || /timeout|ETIMEDOUT|ECONNRESET/i.test(e?.message ?? "")) {
    return true;
  }
  return false;
}

// ─── Groq path ────────────────────────────────────────────────────────────

async function callGroq(
  fetchImpl: typeof fetch,
  apiKey: string,
  request: ProviderRouterRequest,
  model: string,
): Promise<ProviderRouterResponse> {
  const start = Date.now();

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 4096,
    messages: request.messages.map((m) => ({
      role: m.role === "tool" ? "user" : m.role,
      content: m.role === "tool" ? `[tool] ${m.content}` : m.content,
    })),
  };
  if (request.tools && request.tools.length > 0) body.tools = request.tools;

  let raw: {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    raw = await fetchJson(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { fetchFn: fetchImpl, label: "Groq", bodySnippetLength: 200 },
    );
  } catch (err) {
    if (err instanceof HttpError) throw new ProviderRouterError(err.message, err);
    throw err;
  }

  const msg = raw.choices?.[0]?.message;
  const content = msg?.content ?? "";
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  for (const tc of msg?.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: unknown = {};
    const rawArgs = tc.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs.length > 0) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = { __raw: rawArgs };
      }
    } else if (rawArgs) {
      args = rawArgs;
    }
    toolCalls.push({ name, args });
  }

  return {
    content,
    toolCalls,
    usage: {
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
    },
    provider: "groq",
    latencyMs: Date.now() - start,
  };
}
