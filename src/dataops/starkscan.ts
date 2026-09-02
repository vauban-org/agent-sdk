/**
 * StarkscanDataOps — minimal wrapper.
 *
 * Starkscan (starkscan.co) merged into Voyager (voyager.online) as of 2025-2026.
 * This wrapper re-exports VoyagerDataOps with Starkscan-idiomatic naming.
 * The underlying RPC endpoint is the same Nethermind free tier.
 *
 * If the Starkscan indexed REST API (starkscan.co/api-info) becomes separately
 * available with a subscription key, replace the implementation below.
 */

export {
  VoyagerDataOps as StarkscanDataOps,
  VoyagerRpcError as StarkscanError,
} from "./voyager.js";
export type {
  VoyagerConfig as StarkscanConfig,
  WalletEvent,
  HealthCheckResult,
} from "./voyager.js";
