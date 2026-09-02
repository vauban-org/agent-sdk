/**
 * Shielded inter-agent communication channels — ML-KEM-768 stub.
 *
 * Implements checkpoint 2 of sprint-576:agentic-privacy-impl.
 *
 * Design references:
 *   - vauban-privacy-protocol/docs/research/03-agentic-privacy.md — agent privacy design.
 *   - vauban-privacy-protocol/docs/research/07-orq-stealth-addressing.md §3.5 — channel-key
 *     construction adapted for inter-agent use.
 *
 * STUB note: The key exchange uses a Poseidon-based derivation as a placeholder for
 * ML-KEM-768 (CRYSTALS-Kyber, NIST PQC standard). The stream cipher uses a
 * Poseidon-derived keystream as a placeholder for a proper AEAD (e.g., AES-256-GCM
 * or ChaCha20-Poly1305). Both are deterministic and separation-preserving but NOT
 * cryptographically sound for production use.
 *
 * TODO (ORQ-1): Replace establishChannel with ML-KEM-768 Encaps + Poseidon2 KDF.
 * TODO (ORQ-1): Replace sendOverChannel stream cipher with AES-256-GCM or ChaCha20-Poly1305.
 *
 * @module privacy/channel
 */

import { feltMod, labelToFelt, poseidonHashBigInt } from "./poseidon-felt252.js";

// ─── Domain labels ────────────────────────────────────────────────────────────

const LABEL_CHANNEL = labelToFelt("vauban-agent-channel-v1");
const LABEL_CHANNEL_ID = labelToFelt("channel-id");
const LABEL_KEYSTREAM = labelToFelt("keystream");
const LABEL_AUTH_TAG = labelToFelt("auth-tag");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A shielded bidirectional channel between two agents.
 *
 * The channel is directional: sender and receiver roles are asymmetric.
 * Swapping sender/receiver produces a different channel_id and shared_secret,
 * preventing cross-direction replay attacks.
 */
export interface AgentChannel {
  /** Sender's Starknet public key (felt252). */
  sender_pubkey: bigint;
  /** Receiver's Starknet public key (felt252). */
  receiver_pubkey: bigint;
  /**
   * Channel identifier — derived from the shared secret.
   * Safe to include in message headers (public) without revealing the secret.
   */
  channel_id: bigint;
  /**
   * Shared secret — output of STUB key exchange (Poseidon-derived).
   * TODO (ORQ-1): Replace with ML-KEM-768 Encaps output + Poseidon2 KDF.
   * NEVER expose on-chain or in logs.
   */
  shared_secret: bigint;
  /** Unix timestamp (ms) when the channel was established. */
  established_at: number;
}

/**
 * An encrypted message sent over a shielded agent channel.
 *
 * The integrity tag (`tag`) authenticates `(channel_id, nonce, ciphertext)` using
 * the shared secret. A tampered ciphertext or wrong channel produces a tag mismatch.
 */
export interface EncryptedAgentMessage {
  /** Channel this message belongs to (public, used for routing). */
  channel_id: bigint;
  /** Monotonically increasing nonce (felt252). Replay protection. */
  nonce: bigint;
  /** Encrypted payload — XOR of plaintext with Poseidon-derived keystream (STUB). */
  ciphertext: Uint8Array;
  /**
   * HMAC-style authentication tag.
   * tag = Poseidon(shared_secret, nonce, hash(ciphertext)).
   * Verifying this tag before decryption prevents chosen-ciphertext attacks.
   */
  tag: bigint;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export const ChannelError = {
  /** The message's channel_id does not match the provided channel. */
  MismatchedChannel: "MismatchedChannel",
  /** The authentication tag does not match — ciphertext tampered or wrong key. */
  InvalidTag: "InvalidTag",
  /** The message nonce is not strictly greater than the expected previous nonce. */
  ReplayedNonce: "ReplayedNonce",
  /** Channel has not been established (stub for future async establishment). */
  ChannelNotEstablished: "ChannelNotEstablished",
} as const;

export type ChannelErrorKind = (typeof ChannelError)[keyof typeof ChannelError];

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Hash a Uint8Array into a felt252 BigInt for use in the auth tag computation.
 * Uses a simple XOR-folding into felt252 — not a cryptographic hash.
 * TODO (ORQ-1): Replace with Poseidon2 sponge over byte chunks.
 */
function hashBytes(bytes: Uint8Array): bigint {
  // Fold byte array into felt252: accumulate in 31-byte (248-bit) chunks.
  let acc = 0n;
  let chunk = 0n;
  let shift = 0n;
  for (let i = 0; i < bytes.length; i++) {
    chunk = chunk | (BigInt(bytes[i] ?? 0) << shift);
    shift += 8n;
    if (shift >= 248n || i === bytes.length - 1) {
      acc = feltMod(acc ^ chunk);
      chunk = 0n;
      shift = 0n;
    }
  }
  return acc;
}

/**
 * Derive a 248-bit keystream word from the shared secret and a nonce.
 * Used as a one-time pad for a single 31-byte block of plaintext.
 * TODO (ORQ-1): Replace with proper AEAD keystream (ChaCha20-Poly1305 or AES-256-GCM).
 */
function deriveKeystreamWord(sharedSecret: bigint, nonce: bigint, blockIndex: bigint): bigint {
  return poseidonHashBigInt([
    feltMod(sharedSecret),
    feltMod(nonce),
    LABEL_KEYSTREAM,
    feltMod(blockIndex),
  ]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Establish a shielded inter-agent channel.
 *
 * STUB implementation: derives shared_secret via Poseidon over (senderSk, receiverPk,
 * domain label). The channel is directional — sender and receiver roles are asymmetric
 * by design (swapping them produces a different channel_id).
 *
 * TODO (ORQ-1): Replace with ML-KEM-768 Encaps + Poseidon2 KDF per
 * vauban-privacy-protocol/docs/research/07-orq-stealth-addressing.md §3.5.
 *
 * @param senderSk   - Sender's secret key (felt252, NEVER expose).
 * @param receiverPk - Receiver's public key (felt252).
 * @returns AgentChannel with shared_secret and channel_id.
 */
export function establishChannel(senderSk: bigint, receiverPk: bigint): AgentChannel {
  // TODO: ML-KEM-768 Encaps + Poseidon2 KDF (ORQ-1)
  const senderPk = poseidonHashBigInt([feltMod(senderSk), LABEL_CHANNEL]);

  const sharedSecret = poseidonHashBigInt([feltMod(senderSk), feltMod(receiverPk), LABEL_CHANNEL]);

  const channelId = poseidonHashBigInt([sharedSecret, LABEL_CHANNEL_ID]);

  return {
    sender_pubkey: senderPk,
    receiver_pubkey: feltMod(receiverPk),
    channel_id: channelId,
    shared_secret: sharedSecret,
    established_at: Date.now(),
  };
}

/**
 * Compute the authentication tag for a message.
 *
 * tag = Poseidon(shared_secret, nonce, hash(ciphertext))
 *
 * @param sharedSecret - Channel shared secret (felt252).
 * @param ciphertext   - Encrypted payload bytes.
 * @param nonce        - Message nonce (felt252).
 * @returns Authentication tag as felt252 BigInt.
 */
export function computeAuthTag(
  sharedSecret: bigint,
  ciphertext: Uint8Array,
  nonce: bigint,
): bigint {
  const ciphertextHash = hashBytes(ciphertext);
  return poseidonHashBigInt([
    feltMod(sharedSecret),
    feltMod(nonce),
    ciphertextHash,
    LABEL_AUTH_TAG,
  ]);
}

/**
 * Encrypt plaintext and send over a shielded agent channel.
 *
 * Uses a Poseidon-derived keystream (XOR cipher, STUB). The nonce_counter is
 * provided by the caller to support stateless multi-message sessions with replay
 * protection. Each call must use a strictly increasing nonce.
 *
 * TODO (ORQ-1): Replace XOR keystream with ChaCha20-Poly1305 or AES-256-GCM.
 *
 * @param channel      - Established AgentChannel.
 * @param plaintext    - Plaintext bytes to encrypt.
 * @param nonceCounter - Monotonically increasing nonce (caller-managed). Must be
 *                       strictly greater than the last nonce used on this channel.
 * @returns EncryptedAgentMessage ready to transmit.
 */
export function sendOverChannel(
  channel: AgentChannel,
  plaintext: Uint8Array,
  nonceCounter: bigint,
): EncryptedAgentMessage {
  const ciphertext = new Uint8Array(plaintext.length);
  const BLOCK_SIZE = 31; // 248 bits — safe within felt252

  for (let i = 0; i < plaintext.length; i++) {
    const blockIndex = BigInt(Math.floor(i / BLOCK_SIZE));
    const keystreamWord = deriveKeystreamWord(channel.shared_secret, nonceCounter, blockIndex);
    // Extract the byte at position (i % BLOCK_SIZE) from the keystream word.
    const byteOffset = BigInt(i % BLOCK_SIZE);
    const keystreamByte = Number((keystreamWord >> (byteOffset * 8n)) & 0xffn);
    ciphertext[i] = ((plaintext[i] ?? 0) ^ keystreamByte) & 0xff;
  }

  const tag = computeAuthTag(channel.shared_secret, ciphertext, nonceCounter);

  return {
    channel_id: channel.channel_id,
    nonce: nonceCounter,
    ciphertext,
    tag,
  };
}

/**
 * Receive and decrypt a message from a shielded agent channel.
 *
 * Validates:
 *   1. channel_id matches (MismatchedChannel).
 *   2. nonce > expectedNoncePrev (ReplayedNonce).
 *   3. auth tag matches computed tag (InvalidTag).
 *
 * @param channel           - Established AgentChannel (must match sender's channel).
 * @param message           - EncryptedAgentMessage to decrypt.
 * @param expectedNoncePrev - Last accepted nonce on this channel. The message nonce
 *                            must be strictly greater than this value.
 * @returns Decrypted plaintext bytes.
 * @throws {ChannelErrorKind} On validation failure.
 */
export function receiveOverChannel(
  channel: AgentChannel,
  message: EncryptedAgentMessage,
  expectedNoncePrev: bigint,
): Uint8Array {
  // 1. Channel ID check (routing validation)
  if (message.channel_id !== channel.channel_id) {
    throw new Error(ChannelError.MismatchedChannel);
  }

  // 2. Replay protection: nonce must be strictly increasing
  if (message.nonce <= expectedNoncePrev) {
    throw new Error(ChannelError.ReplayedNonce);
  }

  // 3. Auth tag verification (verify before decrypt — authentication first)
  const expectedTag = computeAuthTag(channel.shared_secret, message.ciphertext, message.nonce);
  if (expectedTag !== message.tag) {
    throw new Error(ChannelError.InvalidTag);
  }

  // 4. Decrypt (same XOR keystream as encryption)
  const plaintext = new Uint8Array(message.ciphertext.length);
  const BLOCK_SIZE = 31;

  for (let i = 0; i < message.ciphertext.length; i++) {
    const blockIndex = BigInt(Math.floor(i / BLOCK_SIZE));
    const keystreamWord = deriveKeystreamWord(channel.shared_secret, message.nonce, blockIndex);
    const byteOffset = BigInt(i % BLOCK_SIZE);
    const keystreamByte = Number((keystreamWord >> (byteOffset * 8n)) & 0xffn);
    plaintext[i] = ((message.ciphertext[i] ?? 0) ^ keystreamByte) & 0xff;
  }

  return plaintext;
}
