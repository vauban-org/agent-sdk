/**
 * EXECUTION_MODE guard — sprint-525:quick-2 (anti-pattern #6).
 *
 * Refuses to boot an OODA agent without an explicit execution mode.
 * Forces the operator to make a deliberate choice between safe
 * simulation (`dry-run`) and on-line action (`live`) — no implicit
 * default that could leak side-effects in test environments.
 *
 * @public
 */

import type { ExecutionMode } from "./types.js";

/**
 * Assert that `mode` is a valid `ExecutionMode`. Throws an Error with
 * an actionable message otherwise — typically caught and logged by
 * the agent boot path so the operator immediately sees what to set.
 */
export function assertExecutionMode(mode: unknown): asserts mode is ExecutionMode {
  if (mode !== "dry-run" && mode !== "live") {
    throw new Error(`OODA agent requires EXECUTION_MODE: 'dry-run' | 'live'. Got: ${String(mode)}`);
  }
}

/**
 * Convenience reader: pull EXECUTION_MODE from a process-like env bag
 * and assert it. Centralises the "fail fast at boot" pattern for
 * downstream agents that read from `process.env`.
 */
export function readExecutionModeFromEnv(
  env: Record<string, string | undefined>,
  varName = "EXECUTION_MODE",
): ExecutionMode {
  const raw = env[varName];
  assertExecutionMode(raw);
  return raw;
}
