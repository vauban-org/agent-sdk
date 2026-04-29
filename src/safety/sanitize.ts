/**
 * sanitize — Guards the LLM context against the Lethal Trifecta (Simon Willison).
 * MUST be called before ANY externally-scraped content (Reddit post, tweet,
 * Discord msg, web page, competitor blog) is injected into an LLM prompt or
 * tool result.
 *
 * Defense layers:
 *   Layer 1 — content length cap: 500 chars max per item (hard truncation
 *             with "…" suffix). Protects context budget + limits injection surface.
 *   Layer 2 — instruction marker regex: detects the most common jailbreak
 *             patterns. If match → SKIP the item entirely (NOT sanitize; log
 *             + discard). False positives are acceptable; missed injections are not.
 *   Layer 3 (future) — embedding-based adversarial classifier.
 *
 * IMPORTANT: E2B sandbox protects execution; it does NOT protect LLM context.
 * This sanitizer is the ONLY guard before content reaches the LLM prompt.
 */

export interface SanitizeConfig {
  /** Maximum characters per item (Unicode code points, not bytes). Default: 500. */
  maxContentChars?: number;
  /** Regex list; a match on any pattern causes the item to be skipped. */
  instructionMarkerPatterns?: RegExp[];
  /** If true, log skipped items via console.warn with a structured payload. Default: true. */
  logSkips?: boolean;
}

export interface SanitizedItem<T> {
  /** True if the item survived sanitization (possibly truncated); false if discarded. */
  kept: boolean;
  /** Original item (with content possibly truncated in the `.content` field). */
  item: T;
  /** Reason the item was dropped (undefined if kept). */
  reason?: string;
}

/**
 * Default instruction marker patterns. These target the most common LLM
 * jailbreak vectors observed in 2024-2026:
 *   - Direct instruction overrides ("ignore previous instructions")
 *   - Role impersonation ("SYSTEM:", "ASSISTANT:")
 *   - Tool-call smuggling via fake XML/markdown tags
 *   - ChatML control tokens ("<|system|>")
 *   - Anthropic-style Human:/Assistant: markers smuggled via \n\n escapes
 *   - DAN / jailbreak prompt injections
 *
 * Precision is deliberately tuned toward false-positives-acceptable. A
 * false negative here means a prompt injection succeeds — catastrophic.
 * A false positive means a benign Reddit post is dropped — recoverable.
 */
export const DEFAULT_INSTRUCTION_PATTERNS: RegExp[] = [
  // Direct instruction override (requires both IGNORE + INSTRUCTIONS/PROMPTS)
  /\b(IGNORE\s+(PREVIOUS|ALL|PRIOR)\s+(INSTRUCTIONS?|PROMPTS?))\b/i,
  // Override + role verb (SYSTEM/ASSISTANT/INSTRUCTION)
  /\bOVERRIDE\b.*\b(SYSTEM|ASSISTANT|INSTRUCTION)/i,
  // Role marker injection at start-of-line or after punctuation
  /\b(SYSTEM|ASSISTANT)\s*:/i,
  // XML-style tool_call smuggling (open or close tag)
  /<\/?\s*tool_call\s*>/i,
  // <instructions> fake tag
  /<\/?\s*instructions?\s*>/i,
  // Explicit jailbreak terminology
  /\bJAILBREAK\b/i,
  // DAN prompt variants (DAN + mode/prompt)
  /\bDAN\b.*\b(mode|prompt)/i,
  // ChatML control tokens (<|user|>, <|system|>, <|im_start|>, …)
  /<\|[a-zA-Z_]+\|>/,
  // Anthropic-style marker injection via explicit \n\n (or doubly-escaped
  // \\n\\n when smuggled inside a JSON string). Covers both serialization
  // layers — attackers may inject at either.
  /(?:\\\\|\\)n(?:\\\\|\\)n\s*(?:Human|Assistant)\s*:/,
];

const DEFAULT_MAX_CONTENT_CHARS = 500;

interface SkipLogPayload {
  event: "sanitize.skip";
  reason: string;
  pattern?: string;
  // Preview trimmed further for log size; never logs the full suspect content.
  preview: string;
}

function logSkip(payload: SkipLogPayload): void {
  // Structured warn: downstream observers (pino, OTel) can scrape this.
  // We intentionally avoid dynamic imports of pino here — the sanitizer
  // must be importable from any context (worker, edge, test).
  console.warn(JSON.stringify(payload));
}

/**
 * Truncate a string to `maxChars` Unicode code points, appending "…" when
 * truncation occurs. Uses `Array.from` to split on code points so
 * surrogate pairs (emoji, CJK extended) are never cut mid-pair.
 */
function truncateByCodePoints(content: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const codePoints = Array.from(content);
  if (codePoints.length <= maxChars) return content;
  return `${codePoints.slice(0, maxChars).join("")}…`;
}

/**
 * First pattern that matches the content (or null). Returned for logging
 * so ops can tune regex sensitivity.
 */
function findMatchingPattern(
  content: string,
  patterns: RegExp[],
): RegExp | null {
  for (const pattern of patterns) {
    if (pattern.test(content)) return pattern;
  }
  return null;
}

/**
 * Sanitize a batch of externally-scraped items before LLM ingestion.
 *
 * Contract:
 *   - Throws TypeError if an item's `.content` field is not a string.
 *   - Never mutates input items; returns new objects with truncated content.
 *   - Returns one SanitizedItem per input (1:1 mapping, order preserved).
 *
 * @param items  Array of objects with a `.content: string` field.
 * @param opts   Optional config override.
 */
export function sanitizeExternalInput<T extends { content: string }>(
  items: T[],
  opts?: SanitizeConfig,
): SanitizedItem<T>[] {
  const maxChars = opts?.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const patterns =
    opts?.instructionMarkerPatterns ?? DEFAULT_INSTRUCTION_PATTERNS;
  const shouldLog = opts?.logSkips ?? true;

  return items.map((item) => {
    if (typeof item.content !== "string") {
      // Fail loud: a non-string content field is a contract violation by the
      // caller. Silently coercing would hide a bug.
      throw new TypeError(
        `sanitizeExternalInput: item.content must be a string, got ${typeof item.content}`,
      );
    }

    // Layer 2 first — if an injection marker is found, we DROP the item
    // rather than truncate-and-hope. A truncated jailbreak is still a
    // jailbreak.
    const hit = findMatchingPattern(item.content, patterns);
    if (hit !== null) {
      const reason = `instruction_marker_match:${hit.source}`;
      if (shouldLog) {
        logSkip({
          event: "sanitize.skip",
          reason,
          pattern: hit.source,
          preview: item.content.slice(0, 80),
        });
      }
      return { kept: false, item, reason };
    }

    // Layer 1 — truncate by code points (not bytes) to avoid mangling
    // UTF-8 multi-byte sequences.
    const truncated = truncateByCodePoints(item.content, maxChars);
    const sanitizedItem: T = { ...item, content: truncated };
    return { kept: true, item: sanitizedItem };
  });
}

/**
 * Convenience: run `sanitizeExternalInput` and return only the kept items,
 * already content-truncated. Shape-preserving — the returned array contains
 * the same T type as the input, with content possibly shortened.
 */
export function keepSafeOnly<T extends { content: string }>(
  items: T[],
  opts?: SanitizeConfig,
): T[] {
  return sanitizeExternalInput(items, opts)
    .filter((r) => r.kept)
    .map((r) => r.item);
}
