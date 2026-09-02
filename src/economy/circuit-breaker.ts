/**
 * Fleet-level cost circuit breaker.
 * Pauses all new cycles when rolling spend exceeds threshold.
 * @public
 */

export type CircuitState = "closed" | "open" | "half-open";

/** @public */
export interface CircuitBreakerConfig {
  /** Max USD spend in the window before tripping. Default: 10.0 */
  thresholdUsd: number;
  /** Rolling window duration in ms. Default: 3_600_000 (1h) */
  windowMs: number;
  /** How long to stay open before trying half-open. Default: 300_000 (5min) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  thresholdUsd: 10.0,
  windowMs: 3_600_000,
  cooldownMs: 300_000,
};

interface SpendEntry {
  ts: number;
  costUsd: number;
}

/** @public */
export class FleetCircuitBreaker {
  private readonly cfg: CircuitBreakerConfig;
  private _state: CircuitState = "closed";
  private _openedAt: number | undefined;
  private _halfOpenConsumed = false;
  private _window: SpendEntry[] = [];
  private readonly _now: () => number;

  constructor(config?: Partial<CircuitBreakerConfig>, _now: () => number = Date.now) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this._now = _now;
  }

  /** Returns true if a new cycle should be ALLOWED. False = circuit open. */
  canProceed(): boolean {
    this._evict();
    const now = this._now();

    if (this._state === "open") {
      if (this._openedAt !== undefined && now - this._openedAt >= this.cfg.cooldownMs) {
        this._state = "half-open";
        this._halfOpenConsumed = false;
      } else {
        return false;
      }
    }

    if (this._state === "half-open") {
      if (this._halfOpenConsumed) {
        return false;
      }
      this._halfOpenConsumed = true;
      return true;
    }

    // closed: check threshold
    return this._windowSpend() <= this.cfg.thresholdUsd;
  }

  /** Record a cycle's cost. May trip the breaker. */
  recordCost(costUsd: number): void {
    const now = this._now();
    this._window.push({ ts: now, costUsd });
    this._evict();

    if (this._state === "closed") {
      if (this._windowSpend() > this.cfg.thresholdUsd) {
        this._trip(now);
      }
    } else if (this._state === "half-open") {
      // Probe completed — evaluate
      const spend = this._windowSpend();
      if (spend > this.cfg.thresholdUsd) {
        this._trip(now);
      } else {
        // probe succeeded
        this._state = "closed";
        this._openedAt = undefined;
        this._halfOpenConsumed = false;
      }
    }
    // If open: record but don't change state
  }

  /** Current state. */
  get state(): CircuitState {
    return this._state;
  }

  /** Manually reset (e.g. after operator review). */
  reset(): void {
    this._state = "closed";
    this._openedAt = undefined;
    this._halfOpenConsumed = false;
    this._window = [];
  }

  /** Total spend in current window. */
  get windowSpend(): number {
    this._evict();
    return this._windowSpend();
  }

  // ── private helpers ────────────────────────────────────────────────────────

  private _evict(): void {
    const cutoff = this._now() - this.cfg.windowMs;
    let i = 0;
    while (i < this._window.length && this._window[i].ts < cutoff) i++;
    if (i > 0) this._window.splice(0, i);
  }

  private _windowSpend(): number {
    return this._window.reduce((sum, e) => sum + e.costUsd, 0);
  }

  private _trip(now: number): void {
    this._state = "open";
    this._openedAt = now;
    this._halfOpenConsumed = false;
  }
}
