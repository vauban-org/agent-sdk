/**
 * PricePort — asset price feed contract.
 *
 * Host injects a concrete adapter (e.g., BastionPriceAdapter → Pragma)
 * so agents never depend on a specific price oracle or API.
 *
 * Design: mirrors BrainPort pattern — interface-only, no impl in SDK.
 * @public
 */

export interface PriceEntry {
  asset: string;
  priceUsd: number;
  source: string;
  fetchedAt: string; // ISO
}

/** @public */
export interface PricePort {
  /** Get current price in USD. Returns null if unavailable or stale. */
  getPrice(asset: string): Promise<number | null>;
  /** Get prices for multiple assets in one round-trip when possible. */
  getPrices(assets: string[]): Promise<Record<string, number | null>>;
}
