/**
 * Deprecation helpers.
 *
 * Usage:
 *   export function oldApi() {
 *     deprecated("oldApi", { since: "0.3.0", replacement: "newApi" });
 *     // ... legacy behaviour
 *   }
 *
 * Behaviour:
 *   - First call from a given source-location emits one console.warn.
 *   - Subsequent calls from the same location are silent (deduped by
 *     stack-frame fingerprint).
 *   - Calls from a different source-location warn again.
 *   - Tests can reset state via `_resetDeprecationWarnings()`.
 *
 * Policy (per CONTRACT.md):
 *   - An API marked `@deprecated` at version X.Y.Z is removed at earliest
 *     X.(Y+2).0 (N-2 minor window). Major bumps MAY remove sooner if
 *     explicitly listed in the release notes.
 */

const warnedCallSites = new Set<string>();

export interface DeprecationOptions {
  /** Version at which the API was marked deprecated, e.g. "0.3.0". */
  since?: string;
  /** Name of the replacement API to recommend. */
  replacement?: string;
  /** Version at which removal is scheduled, e.g. "0.5.0". */
  removeIn?: string;
  /** Free-form rationale appended to the warning. */
  note?: string;
  /**
   * Optional logger override (defaults to `console.warn`). Pass
   * `noopLogger.warn` in tests that want silence without resetting state.
   */
  emit?: (message: string) => void;
}

/**
 * Emit a one-time-per-call-site deprecation warning.
 *
 * Dedup key is the top-most user frame of the stack; SDK-internal frames
 * and node:internal frames are skipped so the fingerprint reflects where
 * the deprecated API is *called from* in consumer code.
 */
export function deprecated(
  apiName: string,
  options: DeprecationOptions = {},
): void {
  const callSite = captureCallSite();
  const key = `${apiName}@${callSite}`;

  if (warnedCallSites.has(key)) return;
  warnedCallSites.add(key);

  const parts: string[] = [`[deprecated] ${apiName}`];
  if (options.since) parts.push(`since ${options.since}`);
  if (options.removeIn) parts.push(`removing in ${options.removeIn}`);
  if (options.replacement) parts.push(`use ${options.replacement}`);
  if (options.note) parts.push(options.note);
  parts.push(`call-site: ${callSite}`);

  const message = parts.join(" — ");
  const emit = options.emit ?? ((m: string) => console.warn(m));
  emit(message);
}

/** Test helper — clears the per-call-site dedup set. */
export function _resetDeprecationWarnings(): void {
  warnedCallSites.clear();
}

/** Test helper — returns a snapshot of the warned call-sites. */
export function _deprecationWarnedCallSites(): readonly string[] {
  return Array.from(warnedCallSites);
}

// ─── Internal ────────────────────────────────────────────────────────────

/**
 * Capture the top user-land stack frame. Skips frames inside this file
 * (deprecation.ts) and node internals. Returns `"unknown"` if unavailable.
 */
function captureCallSite(): string {
  const err = new Error("deprecation-trace");
  const stack = err.stack ?? "";
  const lines = stack.split("\n").slice(1); // drop the "Error: ..." header

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    if (trimmed.includes("deprecation.ts")) continue;
    if (trimmed.includes("deprecation.js")) continue;
    if (trimmed.includes("node:internal/")) continue;
    // Normalise to "file:line:col" form
    const match = trimmed.match(/\(([^)]+)\)/) ?? trimmed.match(/at (.+)/);
    if (match?.[1]) return match[1];
  }
  return "unknown";
}
