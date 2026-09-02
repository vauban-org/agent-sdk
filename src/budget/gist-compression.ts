/**
 * gist-compression — ReadAgent-style (Lee et al., ICLR 2024, arXiv:2402.09727)
 * tool-result compaction for multi-turn agent logs.
 *
 * Instead of truncating old tool messages, we generate a 1-2 sentence gist
 * via an LLM callback, preserving task-relevant identifiers and numbers at
 * ~84% compression (per the ReadAgent QuALITY benchmark).
 *
 * Scope:
 *   - gistToolResult:       compress a single tool result into a GistedMessage.
 *   - compactToolLogGist:   replace old tool messages in a log with their gists.
 *
 * Non-goals:
 *   - Token counting / tokenizer (caller provides rough char-based estimate).
 *   - LLM provider selection (caller injects GistLLMFn).
 *   - Persistence (stateless, pure).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Caller-supplied LLM completion function (avoids provider coupling).
 * @public
 */
export type GistLLMFn = (prompt: string) => Promise<string>;

/** @public */
export interface GistCompressionConfig {
  /**
   * Max tokens for the gist (rough estimate via chars/4). Default 80.
   * Passed to the prompt as guidance; the LLM is not hard-capped here.
   */
  maxGistTokens?: number;
  /**
   * Character length threshold above which gisting kicks in.
   * Below this the raw content is returned as-is. Default 400.
   */
  raw_threshold?: number;
}

/** @public */
export interface GistedMessage {
  /** Original role — always "tool" for gisted results. */
  role: "tool";
  /** Tool name, if known. */
  toolName?: string;
  /** Compressed content with "[GIST] " prefix for downstream visibility. */
  content: string;
  /** Original character length, for debug / telemetry. */
  originalLength: number;
}

// ─── Internal constants ───────────────────────────────────────────────────────

const DEFAULT_MAX_GIST_TOKENS = 80;
const DEFAULT_RAW_THRESHOLD = 400;
/** Max chars fed to the LLM prompt (avoids runaway token cost). */
const PROMPT_CONTENT_CAP = 4000;
const GIST_PREFIX = "[GIST] ";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolvedConfig(config?: GistCompressionConfig): {
  maxGistTokens: number;
  rawThreshold: number;
} {
  return {
    maxGistTokens: config?.maxGistTokens ?? DEFAULT_MAX_GIST_TOKENS,
    rawThreshold: config?.raw_threshold ?? DEFAULT_RAW_THRESHOLD,
  };
}

function buildGistPrompt(
  rawContent: string,
  toolName: string | undefined,
  maxGistTokens: number,
): string {
  const snippet = rawContent.slice(0, PROMPT_CONTENT_CAP);
  return `Summarize this tool result in 1-2 sentences (≤${maxGistTokens} tokens). Preserve any numbers, file paths, error codes, or identifiers. Drop boilerplate and prose.\n\nTool: ${toolName ?? "unknown"}\nResult:\n${snippet}\n\nGist (1-2 sentences):`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a gist for a single tool result.
 *
 * - If rawContent.length < raw_threshold: returns { content: rawContent, ... } unchanged.
 * - Else: calls llmFn(prompt), trims, prefixes with "[GIST] ".
 * - On llmFn throw: falls back to truncation `rawContent.slice(0, raw_threshold) + "..."`.
 * @public
 */
export async function gistToolResult(
  rawContent: string,
  toolName: string | undefined,
  llmFn: GistLLMFn,
  config?: GistCompressionConfig,
): Promise<GistedMessage> {
  const { maxGistTokens, rawThreshold } = resolvedConfig(config);
  const originalLength = rawContent.length;

  // Below threshold: keep raw (no LLM call).
  if (originalLength < rawThreshold) {
    return {
      role: "tool",
      toolName,
      content: rawContent,
      originalLength,
    };
  }

  const prompt = buildGistPrompt(rawContent, toolName, maxGistTokens);

  let gistText: string;
  try {
    gistText = (await llmFn(prompt)).trim();
  } catch {
    // Graceful degrade: truncate instead of failing hard.
    gistText = `${rawContent.slice(0, rawThreshold)}...`;
    return {
      role: "tool",
      toolName,
      content: GIST_PREFIX + gistText,
      originalLength,
    };
  }

  return {
    role: "tool",
    toolName,
    content: GIST_PREFIX + gistText,
    originalLength,
  };
}

/**
 * Compact a conversation log by replacing tool messages older than
 * `keepRecentN` with their gists. System and user messages are untouched.
 *
 * @param log         Full conversation log (mixed roles).
 * @param llmFn       LLM completion function for gist generation.
 * @param keepRecentN Keep the most recent N tool messages verbatim. Default 3.
 * @param config      Optional gist compression config.
 * @public
 */
export async function compactToolLogGist(
  log: Array<{ role: string; content: string; toolName?: string }>,
  llmFn: GistLLMFn,
  keepRecentN = 3,
  config?: GistCompressionConfig,
): Promise<Array<{ role: string; content: string; toolName?: string }>> {
  // Identify the indices of tool messages in order.
  const toolIndices: number[] = [];
  for (let i = 0; i < log.length; i++) {
    if (log[i].role === "tool") {
      toolIndices.push(i);
    }
  }

  // Indices of tool messages to gist = all except the last keepRecentN.
  const toGistCount = Math.max(0, toolIndices.length - keepRecentN);
  const indicesToGist = new Set(toolIndices.slice(0, toGistCount));

  if (indicesToGist.size === 0) {
    return log;
  }

  // Build the compacted log.
  const result: Array<{ role: string; content: string; toolName?: string }> = [];

  // Fire all gist requests concurrently.
  const gistPromises: Map<number, Promise<GistedMessage>> = new Map();
  for (const idx of indicesToGist) {
    const msg = log[idx];
    gistPromises.set(idx, gistToolResult(msg.content, msg.toolName, llmFn, config));
  }

  for (let i = 0; i < log.length; i++) {
    const gistPromise = gistPromises.get(i);
    if (gistPromise !== undefined) {
      const gisted = await gistPromise;
      result.push({
        role: "tool",
        content: gisted.content,
        toolName: gisted.toolName,
      });
    } else {
      result.push(log[i]);
    }
  }

  return result;
}
