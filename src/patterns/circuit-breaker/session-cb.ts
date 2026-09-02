import type { OODAContext } from "../../orchestration/ooda/types.js";
/**
 * Pattern A: Session-Level Circuit Breaker — factory.
 * @public
 */
import { logToBrain } from "../_shared/brain-logger.js";
import type {
  CircuitBreakerConfig,
  CircuitSnapshot,
  CircuitState,
  SessionCircuitBreaker,
} from "./types.js";

const NOOP = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createSessionCircuitBreaker(config: CircuitBreakerConfig): SessionCircuitBreaker {
  const { name, thresholds = {}, resetAfterMs = 60_000, brain, onTrip, _now = Date.now } = config;
  const logger = config.logger ?? NOOP;

  const maxTokens = thresholds.maxTokens ?? 50_000;
  const maxConsecutiveErrors = thresholds.maxConsecutiveErrors ?? 5;
  const maxActionCount = thresholds.maxActionCount ?? 200;
  const maxElapsedMs = thresholds.maxElapsedMs ?? 3_600_000;
  const maxCostUsd = thresholds.maxCostUsd ?? 10.0;

  let state: CircuitState = "closed";
  let tripReason: string | undefined;
  let openedAt: number | undefined;
  const sessionStart = _now();
  let tokenCount = 0;
  let consecutiveErrors = 0;
  let actionCount = 0;
  let estimatedCostUsd = 0;

  function snap(): CircuitSnapshot {
    return {
      state,
      tokenCount,
      consecutiveErrors,
      actionCount,
      elapsedMs: _now() - sessionStart,
      estimatedCostUsd,
      tripReason,
      openedAt,
    };
  }

  function doTrip(reason: string): void {
    if (state === "open") return; // idempotent
    state = "open";
    tripReason = reason;
    openedAt = _now();
    logger.warn({ name, reason }, `[session-cb:${name}] OPEN: ${reason}`);
    logToBrain(brain, {
      content: `Session CB '${name}' tripped OPEN. ${reason}`,
      content_type: "event",
      author: `session-cb:${name}`,
      category: "incident",
      tags: ["circuit-breaker", "session", name, "tripped"],
      confidence: 0.95,
      metadata: snap() as unknown as Record<string, unknown>,
    });
    try {
      onTrip?.(snap());
    } catch {
      /* suppress */
    }
  }

  function checkThresholds(): string | null {
    if (tokenCount > maxTokens) return `tokenCount(${tokenCount}) > maxTokens(${maxTokens})`;
    if (consecutiveErrors >= maxConsecutiveErrors)
      return `consecutiveErrors(${consecutiveErrors}) >= ${maxConsecutiveErrors}`;
    if (actionCount > maxActionCount)
      return `actionCount(${actionCount}) > maxActionCount(${maxActionCount})`;
    const elapsed = _now() - sessionStart;
    if (elapsed > maxElapsedMs) return `elapsedMs(${elapsed}) > maxElapsedMs(${maxElapsedMs})`;
    if (estimatedCostUsd > maxCostUsd)
      return `costUsd($${estimatedCostUsd.toFixed(4)}) > maxCostUsd($${maxCostUsd})`;
    return null;
  }

  async function check(_ctx: OODAContext): Promise<{ proceed: boolean; reason?: string }> {
    const now = _now();
    if (state === "open") {
      const elapsed = openedAt !== undefined ? now - openedAt : resetAfterMs;
      if (elapsed < resetAfterMs) {
        return {
          proceed: false,
          reason: `session-cb:${name} OPEN (${tripReason ?? "threshold breach"})`,
        };
      }
      state = "half-open";
      // Reset consecutiveErrors so the inherited count from before the trip
      // does not immediately re-trip the probe via checkThresholds().
      consecutiveErrors = 0;
      logger.info({ name }, `[session-cb:${name}] HALF-OPEN probe`);
    }
    // In half-open state we allow the probe through without re-checking
    // accumulated metrics (tokens, actions, cost) — only recordError() during
    // the probe can re-trip. Threshold re-check only applies to closed state.
    if (state !== "half-open") {
      const violation = checkThresholds();
      if (violation !== null) {
        doTrip(violation);
        return {
          proceed: false,
          reason: `session-cb:${name} tripped: ${violation}`,
        };
      }
    }
    return { proceed: true };
  }

  return {
    name: `session-cb:${name}`,
    check,
    recordTokens(count: number, costUsd?: number): void {
      tokenCount += count;
      if (costUsd !== undefined) estimatedCostUsd += costUsd;
      if (state === "closed") {
        const v = checkThresholds();
        if (v) doTrip(v);
      }
    },
    recordError(): void {
      consecutiveErrors += 1;
      if (state === "half-open") {
        doTrip(`probe failed (errors=${consecutiveErrors})`);
        return;
      }
      if (state === "closed") {
        const v = checkThresholds();
        if (v) doTrip(v);
      }
    },
    recordSuccess(): void {
      // NOTE: does NOT re-check thresholds — token/action/cost counters are
      // not reset by success; only consecutiveErrors is cleared.
      if (state === "half-open") {
        state = "closed";
        consecutiveErrors = 0;
        tripReason = undefined;
        openedAt = undefined;
        logger.info({ name }, `[session-cb:${name}] CLOSED (probe success)`);
        logToBrain(brain, {
          content: `Session CB '${name}' recovered to CLOSED after probe success.`,
          content_type: "event",
          author: `session-cb:${name}`,
          category: "development",
          tags: ["circuit-breaker", "session", name, "recovered"],
          confidence: 0.9,
        });
      } else {
        consecutiveErrors = 0;
      }
    },
    recordAction(): void {
      actionCount += 1;
      if (state === "closed") {
        const v = checkThresholds();
        if (v) doTrip(v);
      }
    },
    reset(): void {
      state = "closed";
      tokenCount = 0;
      consecutiveErrors = 0;
      actionCount = 0;
      estimatedCostUsd = 0;
      tripReason = undefined;
      openedAt = undefined;
    },
    snapshot: snap,
  };
}
