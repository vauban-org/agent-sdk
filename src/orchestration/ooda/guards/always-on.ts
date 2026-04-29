/**
 * always-on session guard — 24/7 no-op.
 *
 * For cron-style agents that run unconditionally (e.g. daily-digest, heartbeat).
 * Satisfies the SessionGuard interface without gating anything.
 *
 * @public
 */

import type { SessionGuard } from "../types.js";

/**
 * Returns a SessionGuard that is always active.
 * Use for agents that must run regardless of time-of-day or calendar.
 */
export function alwaysOn(): SessionGuard {
  return {
    name: "always-on",
    isActive: async (_at: Date): Promise<boolean> => true,
  };
}
