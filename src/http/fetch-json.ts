/**
 * fetch-json — shared "fetch, check ok, parse/throw" primitive.
 *
 * Factors out the `if (!res.ok) throw new Error(...)` boilerplate repeated
 * across ~30 adapter/skill call sites. Deliberately minimal: no retry logic
 * here — compose with `../retry/index.js` (`retry()` honors `.retryable` on
 * thrown errors, matching this module's `HttpError.retryable` convention,
 * the same idiom as `PortError` in `../errors.js`).
 *
 * @public @since 3.6.0
 */

/** @public */
export interface FetchJsonOptions {
  /** Max chars of response body captured in the thrown error. Default 500. */
  bodySnippetLength?: number;
  /** Short prefix for the error message (e.g. "brain", "linkedin"). */
  label?: string;
  /** fetch implementation override (tests, custom transports). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Thrown when a response has a non-2xx status. `retryable` is true for 429
 * and 5xx (the same class the shared `retry()` presets treat as transient),
 * false otherwise — callers with different retry semantics for a given
 * status should catch and reclassify, or use `fetchOrThrow` directly.
 * @public
 */
export class HttpError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodySnippet: string,
    opts: { label?: string; retryable?: boolean } = {},
  ) {
    const prefix = opts.label ? `${opts.label} ` : "";
    super(`${prefix}HTTP ${status} ${url}${bodySnippet ? `: ${bodySnippet}` : ""}`);
    this.name = "HttpError";
    this.retryable = opts.retryable ?? (status === 429 || status >= 500);
  }
}

/** Thrown when a response body fails to parse as JSON. Never retryable. */
export class JsonParseError extends Error {
  readonly retryable = false;
  constructor(
    public readonly url: string,
    cause: unknown,
  ) {
    super(
      `Failed to parse JSON from ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "JsonParseError";
    (this as { cause?: unknown }).cause = cause;
  }
}

async function bodySnippet(res: Response, maxLen: number): Promise<string> {
  // Defensive: some test doubles fake a Response with only {ok, status, json}
  // (cast via `as unknown as Response`) and omit .text() entirely.
  if (typeof res.text !== "function") return "";
  try {
    const text = await res.text();
    return text.slice(0, maxLen);
  } catch {
    return "";
  }
}

/**
 * fetch() and throw a typed {@link HttpError} on any non-2xx status.
 * Returns the raw Response on success — for callers that need headers,
 * streaming bodies, or non-JSON payloads.
 * @public
 */
export async function fetchOrThrow(
  input: string | URL,
  init?: RequestInit,
  opts?: FetchJsonOptions,
): Promise<Response> {
  const doFetch = opts?.fetchFn ?? fetch;
  const res = await doFetch(input, init);
  if (!res.ok) {
    const snippet = await bodySnippet(res, opts?.bodySnippetLength ?? 500);
    throw new HttpError(res.status, String(input), snippet, { label: opts?.label });
  }
  return res;
}

/**
 * fetch(), throw on non-2xx (via {@link fetchOrThrow}), then parse and
 * return the JSON body. Throws {@link JsonParseError} on malformed JSON.
 * @public
 */
export async function fetchJson<T = unknown>(
  input: string | URL,
  init?: RequestInit,
  opts?: FetchJsonOptions,
): Promise<T> {
  const res = await fetchOrThrow(input, init, opts);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new JsonParseError(String(input), err);
  }
}
