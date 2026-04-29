/**
 * CapabilityGate — pre-dispatch hook for tool calls.
 *
 * Decouples the SDK loops from the concrete Biscuit/JWT implementation.
 * Hosts (e.g. the Command Center) wire a `CapabilityGate` whose
 * `verify(call)` consults a Biscuit capability token (and optionally
 * intersects with the SDK's pinned `cc:*` scopes).
 *
 * Contract:
 *  - `verify` MUST be synchronous-or-promise, but MUST NOT throw — every
 *    failure mode is encoded in the returned `CapabilityGateVerdict`.
 *  - `allowed: true` is the only path that authorises a tool call.
 *  - Any non-`allowed:true` verdict denies the call AND emits a structured
 *    reason that the loop relays via the `tool_denied` event hook.
 */

export interface CapabilityGateCall {
  /** Tool name about to be invoked. */
  readonly toolName: string;
  /** Cumulative budget already spent (USD). Loop maintains the counter. */
  readonly budgetUsed: number;
  /** Optional MCP sub-scopes the tool declares (intersected by the host). */
  readonly mcpScopes?: readonly string[];
}

export type CapabilityGateVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface CapabilityGate {
  verify(
    call: CapabilityGateCall,
  ): CapabilityGateVerdict | Promise<CapabilityGateVerdict>;
  /**
   * OPTIONAL — current token expiry (epoch seconds). Hosts that
   * implement automatic renewal expose this so the loop can detect when
   * 80% of the token's lifetime has elapsed and trigger a re-issue.
   */
  getExpiresAt?(): number;
  /**
   * OPTIONAL — current token issuance time (epoch seconds). Used with
   * `getExpiresAt()` to compute the 80% threshold.
   */
  getIssuedAt?(): number;
  /**
   * OPTIONAL — replace the current capability token. Hosts that support
   * auto-renewal call this with the freshly issued token. The gate MUST
   * preserve cumulative `budgetUsed` across token rotations (per-session,
   * not per-token).
   */
  rotateToken?(newTokenB64: string, newExpiresAt: number): void;
}

/**
 * A no-op gate that allows every call. Suitable for tests and for
 * agents running behind external authorisation (e.g. tier-1 read-only
 * loops where Biscuit is enforced upstream).
 */
export const ALLOW_ALL_GATE: CapabilityGate = Object.freeze({
  verify(): CapabilityGateVerdict {
    return { allowed: true };
  },
});
