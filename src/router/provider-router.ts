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

// ─── Public contract ──────────────────────────────────────────────────────

export interface ProviderRouterRequest {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  maxTokens?: number;
}

export interface ProviderRouterResponse {
  content: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  latencyMs: number;
}

export interface ProviderRouter {
  complete(request: ProviderRouterRequest): Promise<ProviderRouterResponse>;
}

export interface ProviderRouterOptions {
  preferAnthropic?: boolean;
  anthropicApiKey?: string;
  groqApiKey?: string;
  queueRetryFn?: (req: unknown) => Promise<void>;
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

export function createProviderRouter(
  opts?: ProviderRouterOptions,
): ProviderRouter {
  const preferAnthropic = opts?.preferAnthropic ?? true;
  const anthropicApiKey =
    opts?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const groqApiKey = opts?.groqApiKey ?? process.env.GROQ_API_KEY;
  const anthropicModel = opts?.model?.anthropic ?? "claude-sonnet-4-6";
  const groqModel = opts?.model?.groq ?? "llama-3.3-70b-versatile";
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
            `[provider-router] Anthropic failed (${classifyAnthropicErr(err)}), falling back to Groq`,
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
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input: unknown }
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

function splitAnthropicMessages(
  input: Array<{ role: string; content: string }>,
): {
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
  if (
    e?.name === "AbortError" ||
    /timeout|ETIMEDOUT|ECONNRESET/i.test(e?.message ?? "")
  ) {
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

  const res = await fetchImpl(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderRouterError(
      `Groq HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }

  const raw = (await res.json()) as {
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
