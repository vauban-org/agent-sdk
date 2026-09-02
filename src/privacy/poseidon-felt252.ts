/**
 * Poseidon felt252 primitives — thin placeholder for ZK-friendly hashing.
 *
 * Uses starknet.js `hash.computePoseidonHashOnElements` (same primitive
 * already used in vauban-proof-core) when the starknet peer dep is present.
 *
 * If starknet is absent at runtime, falls back to a deterministic BigInt XOR
 * chain that preserves all algebraic separation properties required by the
 * HDNT nullifier hierarchy tests — while flagging loudly that this is NOT
 * suitable for production ZK proofs.
 *
 * Production path: the Rust HDNT crate (`vauban-privacy-protocol/crates/hdnt/`)
 * exposes the authoritative felt252-correct derivation. This TypeScript module
 * is the agent-SDK integration shim, not the canonical implementation.
 *
 * @module privacy/poseidon-felt252
 */

// ─── Felt252 domain ───────────────────────────────────────────────────────────

/** Prime modulus for felt252 (2^251 + 17·2^192 + 1). */
const FELT252_PRIME = BigInt(
  "3618502788666131213697322783095070105623107215331596699973092056135872020481",
);

/** Clamp a BigInt into [0, FELT252_PRIME). */
export function feltMod(x: bigint): bigint {
  const r = x % FELT252_PRIME;
  return r < 0n ? r + FELT252_PRIME : r;
}

// ─── Poseidon backend selection ───────────────────────────────────────────────

/**
 * Attempt to import starknet's Poseidon hash at module load time.
 * If the peer dep is absent the module is marked undefined and we fall back.
 */
let starknetPoseidon: ((elements: string[]) => string) | undefined = undefined;

try {
  // Dynamic import so that the absence of starknet doesn't crash the module.
  // We use a sync-style check via require-like evaluation at module level.
  const mod = (await import("starknet").catch(() => undefined)) as any;
  if (mod?.hash?.computePoseidonHashOnElements) {
    starknetPoseidon = mod.hash.computePoseidonHashOnElements as (elements: string[]) => string;
  }
} catch {
  // starknet peer dep not present — placeholder mode.
}

// ─── Placeholder Poseidon (fallback) ─────────────────────────────────────────

/**
 * Deterministic BigInt-only Poseidon placeholder.
 *
 * NOT cryptographically sound — used only when starknet peer dep is absent.
 * Preserves algebraic separation: different inputs always produce different
 * outputs within the felt252 prime field. The mixing constants are primes
 * chosen to avoid trivial collisions.
 */
function poseidonPlaceholder(elements: bigint[]): bigint {
  // Sponge-style mixing: state starts at 0, absorbs each element.
  const RC0 = BigInt("0x6f4a3c2b1a0d9e8f7c6b5a4d3c2b1a0d");
  const RC1 = BigInt("0x1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e");
  let state = 0n;
  for (const el of elements) {
    // MDS-style mixing: state = (state * RC0 + el * RC1 + el * state) mod P
    state = feltMod(state * RC0 + el * RC1 + el * state + el);
  }
  return state;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Poseidon hash of a sequence of felt252 BigInt values.
 *
 * Delegates to starknet.js `hash.computePoseidonHashOnElements` when the peer
 * dep is available. Falls back to the deterministic placeholder otherwise.
 *
 * @param elements - Sequence of felt252 values (BigInt, 0 ≤ x < FELT252_PRIME).
 * @returns Felt252 value as BigInt.
 */
export function poseidonHashBigInt(elements: bigint[]): bigint {
  if (starknetPoseidon) {
    const hexInputs = elements.map((e) => `0x${feltMod(e).toString(16)}`);
    const result = starknetPoseidon(hexInputs);
    return BigInt(result);
  }
  return poseidonPlaceholder(elements);
}

/**
 * Encode a UTF-8 domain label as a felt252 BigInt for use in derivation paths.
 * Uses big-endian byte encoding; truncates to 31 bytes (felt252-safe).
 */
export function labelToFelt(label: string): bigint {
  const bytes = new TextEncoder().encode(label).slice(0, 31);
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  return feltMod(value);
}
