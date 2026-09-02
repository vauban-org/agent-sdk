/**
 * Agent nullifier hierarchy — HDNT derivation in TypeScript.
 *
 * Implements §2 of `vauban-privacy-protocol/docs/research/03-agentic-privacy.md`
 * and the HDNT derivation path specification in
 * `vauban-privacy-protocol/docs/research/05-cross-domain-nullifiers.md`.
 *
 * Derivation paths (Poseidon over felt252):
 *
 *   N_root    = Poseidon(masterKey, label("root"))
 *   N_starknet = Poseidon(N_root, label("starknet"))
 *   N_agent   = Poseidon(N_starknet, agentPubkey)       // per-agent nullifier
 *   N_action  = Poseidon(N_agent, actionId, nonce)       // per-action nullifier
 *
 * Properties guaranteed by the Poseidon permutation:
 *   - Determinism: same inputs → same output (every time, every runtime).
 *   - Agent separation: different agentPubkeys → different N_agent (UNLINK).
 *   - Action binding: different actionIds → different N_action.
 *   - Nonce binding: different nonces → different N_action (replay prevention).
 *   - Cross-agent isolation: two agents performing the same action with the
 *     same nonce still produce different N_action (derived from different N_agent).
 *
 * This module is a TypeScript integration shim for the agent SDK.
 * The authoritative Rust implementation lives in
 * `vauban-privacy-protocol/crates/hdnt/` (created by a parallel worker).
 *
 * @module privacy/nullifier
 */

import { feltMod, labelToFelt, poseidonHashBigInt } from "./poseidon-felt252.js";

// ─── Domain labels (felt252-encoded) ─────────────────────────────────────────

const LABEL_ROOT = labelToFelt("root");
const LABEL_STARKNET = labelToFelt("starknet");

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Derive the per-agent nullifier from the human master key and agent public key.
 *
 * Path: masterKey → N_root → N_starknet → N_agent
 *   N_root     = Poseidon(masterKey, label("root"))
 *   N_starknet = Poseidon(N_root, label("starknet"))
 *   N_agent    = Poseidon(N_starknet, agentPubkey)
 *
 * The master key must NEVER be exposed on-chain.
 * Only N_agent (or further-derived N_action) appears in public contexts.
 *
 * @param masterKey   - Human master key (felt252 — secret, never public).
 * @param agentPubkey - Agent Starknet public key (felt252).
 * @returns Agent nullifier as BigInt (felt252).
 */
export function deriveAgentNullifier(masterKey: bigint, agentPubkey: bigint): bigint {
  const nRoot = poseidonHashBigInt([feltMod(masterKey), LABEL_ROOT]);
  const nStarknet = poseidonHashBigInt([nRoot, LABEL_STARKNET]);
  return poseidonHashBigInt([nStarknet, feltMod(agentPubkey)]);
}

/**
 * Derive the per-action nullifier from the agent nullifier, action ID, and nonce.
 *
 * N_action = Poseidon(N_agent, actionId, nonce)
 *
 * The nonce must be unique per presentation to prevent replay attacks.
 * Once submitted, N_action is stored in the NullifierRegistry as spent.
 *
 * @param agentNullifier - Output of `deriveAgentNullifier`.
 * @param actionId       - Action-type identifier (felt252).
 * @param nonce          - Monotonically increasing or random presentation nonce (felt252).
 * @returns Action nullifier as BigInt (felt252, one-time use).
 */
export function deriveActionNullifier(
  agentNullifier: bigint,
  actionId: bigint,
  nonce: bigint,
): bigint {
  return poseidonHashBigInt([feltMod(agentNullifier), feltMod(actionId), feltMod(nonce)]);
}
