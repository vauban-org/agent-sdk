/**
 * Tests for privacy/nullifier — HDNT agent + action nullifier derivation.
 *
 * Validates properties from vauban-privacy-protocol/docs/research/03-agentic-privacy.md §2:
 *   - Determinism: same inputs → same nullifier.
 *   - Agent-pubkey separation: different agents → different N_agent.
 *   - Action-ID binding: different actions → different N_action.
 *   - Nonce binding: different nonces → different N_action (replay prevention).
 *   - Cross-agent isolation: same action + nonce from different agents → different N_action.
 */

import { describe, expect, it } from "vitest";
import { deriveActionNullifier, deriveAgentNullifier } from "../src/privacy/nullifier.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MASTER_KEY = BigInt("0xdeadbeef01234567deadbeef01234567deadbeef01234567dead");
const AGENT_PUBKEY_A = BigInt("0x0102030405060708090a0b0c0d0e0f");
const AGENT_PUBKEY_B = BigInt("0x1112131415161718191a1b1c1d1e1f");

const ACTION_ID_TRADE = BigInt("0x747261646500000000000000"); // "trade\0..."
const ACTION_ID_REPORT = BigInt("0x7265706f727400000000000"); // "report\0..."

const NONCE_1 = 1n;
const NONCE_2 = 2n;

// ─── Agent nullifier tests ────────────────────────────────────────────────────

describe("deriveAgentNullifier", () => {
  it("is deterministic — same inputs produce same nullifier", () => {
    const n1 = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const n2 = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    expect(n1).toBe(n2);
  });

  it("agent-pubkey separation — different pubkeys produce different nullifiers", () => {
    const nA = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const nB = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_B);
    expect(nA).not.toBe(nB);
  });

  it("master-key separation — different master keys produce different nullifiers", () => {
    const mk2 = BigInt("0x0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const nA1 = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const nA2 = deriveAgentNullifier(mk2, AGENT_PUBKEY_A);
    expect(nA1).not.toBe(nA2);
  });

  it("output is a non-zero BigInt in the felt252 range", () => {
    const n = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const FELT252_PRIME = BigInt(
      "3618502788666131213697322783095070105623107215331596699973092056135872020481",
    );
    expect(typeof n).toBe("bigint");
    expect(n).toBeGreaterThan(0n);
    expect(n).toBeLessThan(FELT252_PRIME);
  });
});

// ─── Action nullifier tests ───────────────────────────────────────────────────

describe("deriveActionNullifier", () => {
  it("is deterministic — same inputs produce same action nullifier", () => {
    const agentN = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const n1 = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_1);
    const n2 = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_1);
    expect(n1).toBe(n2);
  });

  it("action-ID binding — different action IDs produce different nullifiers", () => {
    const agentN = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const nTrade = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_1);
    const nReport = deriveActionNullifier(agentN, ACTION_ID_REPORT, NONCE_1);
    expect(nTrade).not.toBe(nReport);
  });

  it("nonce binding — different nonces produce different nullifiers for same action", () => {
    const agentN = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const n1 = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_1);
    const n2 = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_2);
    expect(n1).not.toBe(n2);
  });

  it("cross-agent isolation — same action + nonce from different agents produce different nullifiers", () => {
    const agentNA = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const agentNB = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_B);
    const nA = deriveActionNullifier(agentNA, ACTION_ID_TRADE, NONCE_1);
    const nB = deriveActionNullifier(agentNB, ACTION_ID_TRADE, NONCE_1);
    expect(nA).not.toBe(nB);
  });

  it("output is a non-zero BigInt in the felt252 range", () => {
    const agentN = deriveAgentNullifier(MASTER_KEY, AGENT_PUBKEY_A);
    const n = deriveActionNullifier(agentN, ACTION_ID_TRADE, NONCE_1);
    const FELT252_PRIME = BigInt(
      "3618502788666131213697322783095070105623107215331596699973092056135872020481",
    );
    expect(typeof n).toBe("bigint");
    expect(n).toBeGreaterThan(0n);
    expect(n).toBeLessThan(FELT252_PRIME);
  });
});
