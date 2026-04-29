/**
 * RenewalManager — coordinates capability-token auto-renewal.
 *
 * Triggers a re-issue when ≥80% of the token lifetime has elapsed.
 * Debounced: a renewal in flight blocks duplicate triggers; once it
 * resolves, the gate is rotated and the timer is reset.
 *
 * The manager is loop-agnostic: any caller (minimal-loop, sdk-loop, or
 * a long-running background job) can `await maybeRenew()` between tool
 * calls. The decision is purely time-based; no per-call cost reset.
 */

import type { CapabilityGate } from "./capability-gate.js";

export interface RenewalRequest {
  readonly currentToken?: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
}

export interface RenewedToken {
  readonly token: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
}

export interface RenewalManagerOptions {
  /** Capability gate exposing getExpiresAt / getIssuedAt / rotateToken. */
  readonly gate: CapabilityGate;
  /** Re-issue callback — host computes the new token (e.g. via boot_agent). */
  readonly reissue: (req: RenewalRequest) => Promise<RenewedToken>;
  /**
   * Lifetime fraction at which renewal triggers. Default 0.80. Must be
   * in (0, 1).
   */
  readonly thresholdFraction?: number;
  /** Clock injection for tests. Default `() => Date.now() / 1000`. */
  readonly now?: () => number;
}

export class RenewalManager {
  private readonly gate: CapabilityGate;
  private readonly reissue: RenewalManagerOptions["reissue"];
  private readonly thresholdFraction: number;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;

  constructor(opts: RenewalManagerOptions) {
    this.gate = opts.gate;
    this.reissue = opts.reissue;
    this.thresholdFraction = opts.thresholdFraction ?? 0.8;
    if (this.thresholdFraction <= 0 || this.thresholdFraction >= 1) {
      throw new RangeError("thresholdFraction must be in (0, 1)");
    }
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  /**
   * Trigger renewal if the current token is past the threshold. Idempotent
   * across concurrent callers via the in-flight promise.
   */
  async maybeRenew(): Promise<boolean> {
    if (this.inFlight) {
      await this.inFlight;
      return true;
    }
    const expiresAt = this.gate.getExpiresAt?.();
    const issuedAt = this.gate.getIssuedAt?.();
    if (expiresAt === undefined || issuedAt === undefined) return false;

    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0) return false;
    const elapsed = this.now() - issuedAt;
    if (elapsed / lifetime < this.thresholdFraction) return false;

    const promise = (async () => {
      const renewed = await this.reissue({
        issuedAtEpochSeconds: issuedAt,
        expiresAtEpochSeconds: expiresAt,
      });
      this.gate.rotateToken?.(renewed.token, renewed.expiresAtEpochSeconds);
    })();
    this.inFlight = promise.finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    return true;
  }
}
