/**
 * Universal Anonymity Root (UAR) contribution — agent anchor commitments.
 *
 * Implements checkpoint 5 of sprint-576:agentic-privacy-impl (ORQ-4):
 * - `contributeAnchorToUAR(agentClaim, holderBlinding)` produces a UAR leaf
 *   commitment for the `agentic` domain.
 * - Anchor: `poseidon2(domain_tag, agentNullifier, holderBlinding)` per ORQ-4 §3.2.
 * - Epoch-stamped for freshness tracking (per-presentation linkability mitigation).
 * - Mock submit to UAR aggregator (no network I/O in this slice).
 *
 * Cross-agent unlinkability (ORQ-4 G5):
 *   Two agents presenting to the same verifier produce different leaves because:
 *   - Different `agentNullifier` → different `domain_specific_anchor`.
 *   - Same holder may use different `holderBlinding` per presentation → different leaf.
 *   An observer sees only `anchor_commitment` and cannot link across domains or agents.
 *
 * References:
 *   - vauban-privacy-protocol/docs/research/10-orq-cross-domain-anon.md §3.2-§3.3
 *   - docs/research/03-agentic-privacy.md §2 (agent nullifier hierarchy)
 *
 * @module privacy/uar
 */

import type { AgentClaim } from "./composition.js";
import { feltMod, labelToFelt, poseidonHashBigInt } from "./poseidon-felt252.js";

// ─── Domain tags ──────────────────────────────────────────────────────────────

/**
 * Domain tag for agentic leaves in the UAR.
 * Per ORQ-4 §3.3 projection rules.
 *
 * Matches the canonical tag used by the Rust UAR aggregator
 * (`vauban-domain-agentic-v1`).
 */
export const UAR_DOMAIN_TAG_AGENTIC = labelToFelt("vauban-domain-agentic-v1");

/**
 * Sentinel domain tags for other Vauban domains (domain separation reference).
 * These are NOT produced by this module — listed for separation verification in tests.
 */
export const UAR_DOMAIN_TAG_STARKNET = labelToFelt("vauban-domain-starknet-shieldedvault-v1");
export const UAR_DOMAIN_TAG_W3C_VC = labelToFelt("vauban-domain-w3c-vc-v1");
export const UAR_DOMAIN_TAG_MDOC = labelToFelt("vauban-domain-iso18013-mdoc-v1");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single UAR leaf contributed by an agentic claim.
 *
 * Per ORQ-4 §3.2:
 *   anchor_commitment = poseidon2(domain_tag, domain_specific_anchor, holder_blinding)
 *
 * For the agentic domain:
 *   domain_specific_anchor = agentNullifier (the HDNT nullifier for the agent)
 *   domain_tag             = UAR_DOMAIN_TAG_AGENTIC
 */
export interface UARLeaf {
  /**
   * Domain tag felt252 — identifies the `agentic` domain in the UAR.
   * Public: verifier knows which domain the leaf came from.
   */
  domainTag: bigint;
  /**
   * Blinded anchor commitment.
   * anchor = poseidon2(domainTag, agentNullifier, holderBlinding)
   *
   * The holderBlinding is NEVER revealed — the leaf is indistinguishable
   * from leaves contributed by other agents or other domains.
   */
  anchor: bigint;
  /**
   * Epoch number when this leaf was produced.
   * Epoch = Math.floor(Date.now() / 3600_000) — hourly cadence per ORQ-4 §3.4.
   *
   * Freshness: verifiers accept leaves within a configurable window (default 24h = 24 epochs).
   */
  epoch: number;
  /**
   * The role of the contributing agent (informational, not included in anchor hash).
   * Helps the holder track which agent contributed which leaf.
   * NOT published to the UAR aggregator — local metadata only.
   */
  agentRole: string;
}

/**
 * Mock submit result from the UAR aggregator.
 *
 * Phase 1 is a mock — no network I/O. Phase 1.5+ will wire to the real
 * off-chain aggregator service (separate ADR-ECO).
 *
 * The `leafIndex` is a deterministic mock index derived from the anchor
 * commitment to keep tests reproducible.
 */
export interface UARAggregatorReceipt {
  /** The submitted anchor commitment. */
  anchor: bigint;
  /** Epoch of submission. */
  epoch: number;
  /**
   * Mock leaf index in the Sparse Merkle Tree (depth 64).
   * Phase 1: derived from anchor via felt-mod to [0, 2^32) for tractability.
   * Phase 2+: real SMT path from the aggregator.
   */
  leafIndex: bigint;
  /**
   * Whether the leaf was accepted (always true in mock).
   * Phase 2+: false if epoch is stale or anchor is malformed.
   */
  accepted: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Current epoch number (hourly cadence).
 * Epoch = Math.floor(Date.now() / 3_600_000).
 * Deterministic within a single hour — prevents timing-based linkability
 * from sub-second clock differences.
 */
function currentEpoch(): number {
  return Math.floor(Date.now() / 3_600_000);
}

/**
 * Derive a mock leaf index from an anchor commitment.
 * Deterministic: same anchor → same index. Phase 1 only.
 */
function mockLeafIndex(anchor: bigint): bigint {
  // Fold anchor into [0, 2^32) — deterministic, no RNG.
  return anchor % 2n ** 32n;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Contribute an agent's HDNT nullifier to the Universal Anonymity Root (UAR).
 *
 * Computes the UAR leaf commitment per ORQ-4 §3.2:
 *   anchor = poseidon2(domain_tag, agentNullifier, holderBlinding)
 *
 * The `holderBlinding` is a 32-byte random felt (felt252 BigInt) chosen by
 * the holder. It MUST be:
 *   - Freshly generated per leaf contribution (never reused across presentations).
 *   - Secret: never revealed to the verifier or the UAR aggregator.
 *   - Derived from the holder's secret key (e.g., Poseidon(masterKey, epoch, role)).
 *
 * **Cross-agent unlinkability**: Two agents with different `agentNullifier`
 * values produce different `anchor` values even with the same `holderBlinding`,
 * because `agentNullifier` is part of the Poseidon preimage. Conversely, the
 * same agent with different `holderBlinding` values produces different anchors,
 * preventing cross-presentation correlation.
 *
 * @param agentClaim     - AgentClaim whose nullifier contributes the leaf.
 * @param holderBlinding - 32-byte random felt (felt252 BigInt). Secret.
 * @returns UARLeaf — the commitment, epoch, and domain metadata.
 */
export function contributeAnchorToUAR(agentClaim: AgentClaim, holderBlinding: bigint): UARLeaf {
  const anchor = poseidonHashBigInt([
    UAR_DOMAIN_TAG_AGENTIC,
    feltMod(agentClaim.agentNullifier),
    feltMod(holderBlinding),
  ]);

  return {
    domainTag: UAR_DOMAIN_TAG_AGENTIC,
    anchor,
    epoch: currentEpoch(),
    agentRole: agentClaim.role,
  };
}

/**
 * Mock-submit a UAR leaf to the off-chain aggregator service.
 *
 * Phase 1: no network I/O. Returns a deterministic mock receipt.
 * Phase 1.5+: replace body with HTTP POST to the aggregator endpoint.
 *
 * The aggregator would:
 *   1. Validate the anchor commitment format (felt252 in range).
 *   2. Verify the epoch is within the freshness window.
 *   3. Insert the leaf into the SMT at `leafIndex`.
 *   4. Return the SMT root update (deferred to Phase 2).
 *
 * TODO (Phase 1.5): Replace mock with real aggregator HTTP call.
 *
 * @param leaf - UARLeaf to submit.
 * @returns UARAggregatorReceipt with mock leaf index.
 */
export function mockSubmitToUAR(leaf: UARLeaf): UARAggregatorReceipt {
  return {
    anchor: leaf.anchor,
    epoch: leaf.epoch,
    leafIndex: mockLeafIndex(leaf.anchor),
    accepted: true,
  };
}

/**
 * Verify that a UAR leaf is fresh (within the given window).
 *
 * A leaf is fresh if its epoch is within `maxEpochAge` epochs of the current
 * epoch. Default window: 24 epochs = 24 hours (per ORQ-4 §4.4).
 *
 * @param leaf         - UARLeaf to verify.
 * @param maxEpochAge  - Maximum allowed epoch age (default 24).
 * @returns true if the leaf is within the freshness window.
 */
export function isLeafFresh(leaf: UARLeaf, maxEpochAge = 24): boolean {
  const now = currentEpoch();
  return now - leaf.epoch <= maxEpochAge;
}

/**
 * Contribute multiple agent claims to the UAR, returning one leaf per claim.
 *
 * Each leaf uses the SAME `holderBlinding` — the caller must provide a
 * separate blinding per claim for maximum privacy. This helper is a
 * convenience for bulk contribution with a single blinding (e.g., for tests).
 *
 * For production use, derive per-leaf blindings:
 *   blinding_i = Poseidon(masterKey, epoch, role_i)
 *
 * @param agentClaims    - Array of AgentClaims to contribute.
 * @param holderBlinding - Shared blinding (use per-leaf blindings in production).
 * @returns Array of UARLeaf, one per claim.
 */
export function contributeMultipleAnchors(
  agentClaims: AgentClaim[],
  holderBlinding: bigint,
): UARLeaf[] {
  return agentClaims.map((claim) => contributeAnchorToUAR(claim, holderBlinding));
}
