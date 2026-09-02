/**
 * FallbackAdapter — cascading TimestampPort composition.
 *
 * Pure cascade logic with no ASN.1 / wire-format knowledge.
 * Adapters are tried in order; the first success wins.
 * All failures aggregate into AllAdaptersFailedError.
 *
 * For verify(): the first adapter whose tsa URL matches the receipt is used.
 * If none match, falls back to trying each in order.
 *
 * @module proof/fallback-adapter
 */

import type { TimestampPort } from "../ports/timestamp.js";
import type { SignedReceipt } from "../trace/schema.js";

/**
 * Thrown when all adapters fail during a `request()` call.
 * Aggregates individual errors for diagnostics.
 * @public
 */
export class AllAdaptersFailedError extends AggregateError {
  constructor(errors: Error[], message = "All TimestampPort adapters failed") {
    super(errors, message);
    this.name = "AllAdaptersFailedError";
  }
}

/**
 * FallbackAdapter — tries adapters in insertion order.
 *
 * Construction throws immediately if the adapters array is empty
 * (fail-closed; never silently degrade to a misconfigured state).
 * @public
 */
export class FallbackAdapter implements TimestampPort {
  private readonly _adapters: readonly TimestampPort[];

  constructor(adapters: readonly TimestampPort[]) {
    if (adapters.length === 0) {
      throw new Error(
        "FallbackAdapter requires at least one adapter. " +
          "Pass one or more TimestampPort implementations.",
      );
    }
    this._adapters = adapters;
  }

  /**
   * Try each adapter in order. Returns the first successful receipt.
   * Throws AllAdaptersFailedError if every adapter throws.
   */
  async request(rootHash: string): Promise<SignedReceipt> {
    const errors: Error[] = [];

    for (const adapter of this._adapters) {
      try {
        return await adapter.request(rootHash);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    throw new AllAdaptersFailedError(errors);
  }

  /**
   * Verify a receipt.
   *
   * Strategy: try the first adapter whose tsa URL matches receipt.tsa first
   * (fast path). If none match (or the match fails), try all adapters in order
   * and return the first successful result.
   *
   * Returns `{ valid: false }` only when all adapters declare invalid or throw.
   */
  async verify(
    receipt: SignedReceipt,
    rootHash: string,
  ): Promise<{ valid: boolean; reason?: string }> {
    // Fast-path: find an adapter that "owns" this receipt by TSA URL.
    // Adapters expose their TSA URL via an optional `tsaUrl` property (duck-typed).
    const matchingIdx = this._adapters.findIndex(
      (a) =>
        typeof (a as unknown as Record<string, unknown>).tsaUrl === "string" &&
        (a as unknown as Record<string, unknown>).tsaUrl === receipt.tsa,
    );

    if (matchingIdx !== -1) {
      try {
        const result = await this._adapters[matchingIdx].verify(receipt, rootHash);
        if (result.valid) return result;
      } catch {
        // Fall through to full scan.
      }
    }

    // Full scan: try each adapter.
    let lastReason: string | undefined;
    for (const adapter of this._adapters) {
      try {
        const result = await adapter.verify(receipt, rootHash);
        if (result.valid) return result;
        lastReason = result.reason;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : "adapter verify threw";
      }
    }

    return {
      valid: false,
      reason: lastReason ?? "no adapter could verify receipt",
    };
  }
}
