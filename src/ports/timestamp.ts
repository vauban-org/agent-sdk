/**
 * TimestampPort — RFC 3161 TSA interface for the agent-sdk core.
 *
 * R8-B1 constraint: only the interface + NullTimestampPort live here.
 * Concrete adapters (FreeTSAAdapter, etc.) and all ASN.1/DER/PKCS#7
 * parsing belong in `@vauban-org/agent-sdk-verify` (external package).
 *
 * @module ports/timestamp
 */

import type { SignedReceipt } from "../trace/schema.js";

/**
 * Port for requesting and verifying RFC 3161 TSA timestamps.
 * Injected by the host at boot time.
 * @public
 */
export interface TimestampPort {
  /**
   * Request a signed timestamp for `rootHash` from a TSA.
   *
   * @param rootHash - Hex-encoded SHA-256 root hash to timestamp.
   * @returns Resolved SignedReceipt on success.
   * @throws On TSA communication failure or rejection.
   */
  request(rootHash: string): Promise<SignedReceipt>;

  /**
   * Verify a receipt locally against `rootHash`.
   * MUST NOT require an online OCSP check — offline verification only.
   *
   * @param receipt  - The SignedReceipt to verify.
   * @param rootHash - Expected hex-encoded SHA-256 root hash.
   * @returns { valid: true } on success or { valid: false, reason } on failure.
   */
  verify(receipt: SignedReceipt, rootHash: string): Promise<{ valid: boolean; reason?: string }>;
}

/**
 * No-op TimestampPort for tests and development.
 *
 * `request()` always throws — configure a real TimestampPort
 * (e.g. `FreeTSAAdapter` from `@vauban-org/agent-sdk-verify`) for production.
 *
 * `verify()` always returns `{ valid: false }` — it cannot verify receipts
 * it never issued.
 * @public
 */
export class NullTimestampPort implements TimestampPort {
  async request(_rootHash: string): Promise<SignedReceipt> {
    throw new Error(
      "NullTimestampPort: configure a real TimestampPort " +
        "(e.g., FreeTSAAdapter from @vauban-org/agent-sdk-verify) for production.",
    );
  }

  async verify(
    _receipt: SignedReceipt,
    _rootHash: string,
  ): Promise<{ valid: boolean; reason: string }> {
    return { valid: false, reason: "NullTimestampPort cannot verify receipts" };
  }
}
