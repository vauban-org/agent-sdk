/**
 * Tests for privacy/channel — shielded inter-agent encrypted channels.
 *
 * Validates checkpoint 2 of sprint-576:agentic-privacy-impl:
 *   - establishChannel is deterministic and asymmetric (sender/receiver roles matter).
 *   - send/receive roundtrip recovers exact plaintext.
 *   - Replay attacks (same nonce) are rejected.
 *   - Tampered ciphertext triggers InvalidTag.
 *   - Mismatched channel_id triggers MismatchedChannel.
 *
 * Design ref: vauban-privacy-protocol/docs/research/03-agentic-privacy.md
 *             vauban-privacy-protocol/docs/research/07-orq-stealth-addressing.md §3.5
 */

import { describe, expect, it } from "vitest";
import {
  ChannelError,
  type EncryptedAgentMessage,
  computeAuthTag,
  establishChannel,
  receiveOverChannel,
  sendOverChannel,
} from "../src/privacy/channel.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SENDER_SK = BigInt("0xdeadbeef01234567deadbeef01234567deadbeef01234567dead");
const RECEIVER_PK = BigInt("0x0102030405060708090a0b0c0d0e0f1011121314151617181920");

// A different secret key for asymmetry tests
const OTHER_SK = BigInt("0xabcdef01234567abcdef01234567abcdef01234567abcdef0123");

const PLAINTEXT_HELLO = new TextEncoder().encode("Hello, inter-agent channel!");
const NONCE_1 = 1n;
const NONCE_2 = 2n;

// ─── establishChannel tests ───────────────────────────────────────────────────

describe("establishChannel", () => {
  it("establishChannel_deterministic — same inputs produce identical channel", () => {
    const ch1 = establishChannel(SENDER_SK, RECEIVER_PK);
    const ch2 = establishChannel(SENDER_SK, RECEIVER_PK);

    expect(ch1.channel_id).toBe(ch2.channel_id);
    expect(ch1.shared_secret).toBe(ch2.shared_secret);
    expect(ch1.sender_pubkey).toBe(ch2.sender_pubkey);
    expect(ch1.receiver_pubkey).toBe(ch2.receiver_pubkey);
  });

  it("establishChannel_asymmetric_pk_pk_ne_pk_sk — swapping sender/receiver produces a different channel", () => {
    // Channel from SENDER_SK → RECEIVER_PK
    const chAB = establishChannel(SENDER_SK, RECEIVER_PK);
    // Channel from OTHER_SK → RECEIVER_PK (different sender)
    const chCB = establishChannel(OTHER_SK, RECEIVER_PK);

    // Different senders must produce different channel IDs and secrets
    expect(chAB.channel_id).not.toBe(chCB.channel_id);
    expect(chAB.shared_secret).not.toBe(chCB.shared_secret);
  });

  it("sender pubkey differs from receiver pubkey", () => {
    const ch = establishChannel(SENDER_SK, RECEIVER_PK);
    // sender_pubkey is derived from sender secret — must differ from receiver
    expect(ch.sender_pubkey).not.toBe(ch.receiver_pubkey);
  });

  it("established_at is a recent Unix ms timestamp", () => {
    const before = Date.now();
    const ch = establishChannel(SENDER_SK, RECEIVER_PK);
    const after = Date.now();
    expect(ch.established_at).toBeGreaterThanOrEqual(before);
    expect(ch.established_at).toBeLessThanOrEqual(after);
  });
});

// ─── send_receive roundtrip ───────────────────────────────────────────────────

describe("sendOverChannel / receiveOverChannel", () => {
  it("send_receive_roundtrip_recovers_plaintext — short message", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, PLAINTEXT_HELLO, NONCE_1);
    const recovered = receiveOverChannel(channel, msg, 0n);
    expect(recovered).toEqual(PLAINTEXT_HELLO);
  });

  it("send_receive_roundtrip_recovers_plaintext — empty payload", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, new Uint8Array(0), NONCE_1);
    const recovered = receiveOverChannel(channel, msg, 0n);
    expect(recovered).toEqual(new Uint8Array(0));
  });

  it("send_receive_roundtrip_recovers_plaintext — multi-block payload (>31 bytes)", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    // 96 bytes > 3 Poseidon blocks of 31 bytes each
    const large = new Uint8Array(96).fill(0xab);
    const msg = sendOverChannel(channel, large, NONCE_1);
    const recovered = receiveOverChannel(channel, msg, 0n);
    expect(recovered).toEqual(large);
  });

  it("send_receive_roundtrip_recovers_plaintext — sequential nonces", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg1 = sendOverChannel(channel, new TextEncoder().encode("first"), NONCE_1);
    const msg2 = sendOverChannel(channel, new TextEncoder().encode("second"), NONCE_2);

    const r1 = receiveOverChannel(channel, msg1, 0n);
    const r2 = receiveOverChannel(channel, msg2, NONCE_1);

    expect(new TextDecoder().decode(r1)).toBe("first");
    expect(new TextDecoder().decode(r2)).toBe("second");
  });

  // ─── replay_attack_rejected ────────────────────────────────────────────────

  it("replay_attack_rejected — same nonce twice throws ReplayedNonce", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, PLAINTEXT_HELLO, NONCE_1);

    // First receive succeeds (expectedNoncePrev = 0 < nonce = 1)
    receiveOverChannel(channel, msg, 0n);

    // Second attempt with same expectedNoncePrev that no longer holds (nonce <= 1)
    expect(() => receiveOverChannel(channel, msg, NONCE_1)).toThrow(ChannelError.ReplayedNonce);
  });

  it("replay_attack_rejected — nonce equal to expectedNoncePrev throws ReplayedNonce", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, PLAINTEXT_HELLO, NONCE_1);

    // expectedNoncePrev = 1, message nonce = 1 → not strictly greater
    expect(() => receiveOverChannel(channel, msg, NONCE_1)).toThrow(ChannelError.ReplayedNonce);
  });

  // ─── tampered_ciphertext_rejected ─────────────────────────────────────────

  it("tampered_ciphertext_rejected — flipping a ciphertext byte throws InvalidTag", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, PLAINTEXT_HELLO, NONCE_1);

    // Flip the first byte of the ciphertext
    const tampered: EncryptedAgentMessage = {
      ...msg,
      ciphertext: new Uint8Array(msg.ciphertext).map((b, i) => (i === 0 ? b ^ 0xff : b)),
    };

    expect(() => receiveOverChannel(channel, tampered, 0n)).toThrow(ChannelError.InvalidTag);
  });

  it("tampered_ciphertext_rejected — flipping last byte throws InvalidTag", () => {
    const channel = establishChannel(SENDER_SK, RECEIVER_PK);
    const msg = sendOverChannel(channel, PLAINTEXT_HELLO, NONCE_1);

    const tampered: EncryptedAgentMessage = {
      ...msg,
      ciphertext: new Uint8Array(msg.ciphertext).map((b, i) =>
        i === msg.ciphertext.length - 1 ? b ^ 0x01 : b,
      ),
    };

    expect(() => receiveOverChannel(channel, tampered, 0n)).toThrow(ChannelError.InvalidTag);
  });

  // ─── mismatched_channel_id_rejected ───────────────────────────────────────

  it("mismatched_channel_id_rejected — wrong channel throws MismatchedChannel", () => {
    const channelA = establishChannel(SENDER_SK, RECEIVER_PK);
    const channelB = establishChannel(OTHER_SK, RECEIVER_PK);

    // Message sent on channelA, received on channelB
    const msg = sendOverChannel(channelA, PLAINTEXT_HELLO, NONCE_1);

    expect(() => receiveOverChannel(channelB, msg, 0n)).toThrow(ChannelError.MismatchedChannel);
  });
});

// ─── computeAuthTag tests ─────────────────────────────────────────────────────

describe("computeAuthTag", () => {
  it("is deterministic — same inputs produce same tag", () => {
    const secret = BigInt("0x1234567890abcdef");
    const ct = new Uint8Array([0x01, 0x02, 0x03]);
    const t1 = computeAuthTag(secret, ct, NONCE_1);
    const t2 = computeAuthTag(secret, ct, NONCE_1);
    expect(t1).toBe(t2);
  });

  it("different nonces produce different tags", () => {
    const secret = BigInt("0x1234567890abcdef");
    const ct = new Uint8Array([0x01, 0x02, 0x03]);
    const t1 = computeAuthTag(secret, ct, NONCE_1);
    const t2 = computeAuthTag(secret, ct, NONCE_2);
    expect(t1).not.toBe(t2);
  });

  it("different ciphertext produces different tag", () => {
    const secret = BigInt("0x1234567890abcdef");
    const ct1 = new Uint8Array([0x01, 0x02, 0x03]);
    const ct2 = new Uint8Array([0x01, 0x02, 0x04]);
    const t1 = computeAuthTag(secret, ct1, NONCE_1);
    const t2 = computeAuthTag(secret, ct2, NONCE_1);
    expect(t1).not.toBe(t2);
  });
});
