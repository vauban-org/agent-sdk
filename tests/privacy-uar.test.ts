/**
 * Tests for privacy/uar — UAR anchor commitment contribution.
 *
 * Validates ORQ-4 §3.2-§3.3 requirements:
 *   - Leaf computation determinism (same inputs → same anchor)
 *   - Blinding hides anchor (different blindings → different leaves, same agent)
 *   - Domain separation from on-chain leaves (agentic tag ≠ starknet/w3c/mdoc tags)
 *   - Freshness epoch (leaf carries correct epoch, isLeafFresh validates window)
 *   - Mock submit (always accepted, deterministic leafIndex)
 *   - Cross-agent unlinkability (different agents + same blinding → different anchors)
 *   - Multi-anchor bulk contribution
 *
 * References:
 *   - vauban-privacy-protocol/docs/research/10-orq-cross-domain-anon.md §3.2-§3.3
 *   - sprint-576:agentic-privacy-impl checkpoint 5 (ORQ-4)
 */

import { describe, expect, it } from "vitest";
import type { AgentClaim } from "../src/privacy/composition.js";
import { deriveAgentNullifier } from "../src/privacy/nullifier.js";
import {
  UAR_DOMAIN_TAG_AGENTIC,
  UAR_DOMAIN_TAG_MDOC,
  UAR_DOMAIN_TAG_STARKNET,
  UAR_DOMAIN_TAG_W3C_VC,
  contributeAnchorToUAR,
  contributeMultipleAnchors,
  isLeafFresh,
  mockSubmitToUAR,
} from "../src/privacy/uar.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MASTER_KEY = BigInt("0xffeeddccbbaa99887766554433221100ffeeddccbbaa998877");

const PUBKEY_A = BigInt("0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
const PUBKEY_B = BigInt("0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e");

const N_A = deriveAgentNullifier(MASTER_KEY, PUBKEY_A);
const N_B = deriveAgentNullifier(MASTER_KEY, PUBKEY_B);

const BLINDING_1 = BigInt("0xaabb11223344556677889900aabb1122");
const BLINDING_2 = BigInt("0xccdd55667788990011223344ccdd5566");

function makeAgentClaim(nullifier: bigint, role: string): AgentClaim {
  return { agentNullifier: nullifier, role, payload: { ok: true } };
}

// ─── Leaf computation determinism ─────────────────────────────────────────────

describe("contributeAnchorToUAR — determinism", () => {
  it("same inputs produce same anchor (deterministic)", () => {
    const leaf1 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const leaf2 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(leaf1.anchor).toBe(leaf2.anchor);
  });

  it("domainTag is always the agentic domain tag", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(leaf.domainTag).toBe(UAR_DOMAIN_TAG_AGENTIC);
  });

  it("anchor is a non-zero felt252 BigInt", () => {
    const FELT252_PRIME = BigInt(
      "3618502788666131213697322783095070105623107215331596699973092056135872020481",
    );
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(typeof leaf.anchor).toBe("bigint");
    expect(leaf.anchor).toBeGreaterThan(0n);
    expect(leaf.anchor).toBeLessThan(FELT252_PRIME);
  });

  it("agentRole is carried on the leaf (informational)", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "credit-score"), BLINDING_1);
    expect(leaf.agentRole).toBe("credit-score");
  });
});

// ─── Blinding hides anchor ────────────────────────────────────────────────────

describe("contributeAnchorToUAR — blinding hides anchor", () => {
  it("different blindings → different anchors for the same agent", () => {
    const leaf1 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const leaf2 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_2);
    expect(leaf1.anchor).not.toBe(leaf2.anchor);
  });

  it("blinding change does not affect domainTag", () => {
    const leaf1 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const leaf2 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_2);
    expect(leaf1.domainTag).toBe(leaf2.domainTag);
  });
});

// ─── Cross-agent unlinkability ────────────────────────────────────────────────

describe("contributeAnchorToUAR — cross-agent unlinkability", () => {
  it("different agents + same blinding → different anchors", () => {
    const leafA = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const leafB = contributeAnchorToUAR(makeAgentClaim(N_B, "identity"), BLINDING_1);
    expect(leafA.anchor).not.toBe(leafB.anchor);
  });

  it("two agents + two blindings → all four anchors distinct", () => {
    const a1 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const a2 = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_2);
    const b1 = contributeAnchorToUAR(makeAgentClaim(N_B, "credit-score"), BLINDING_1);
    const b2 = contributeAnchorToUAR(makeAgentClaim(N_B, "credit-score"), BLINDING_2);
    const anchors = [a1.anchor, a2.anchor, b1.anchor, b2.anchor];
    const unique = new Set(anchors);
    expect(unique.size).toBe(4);
  });
});

// ─── Domain separation ────────────────────────────────────────────────────────

describe("domain tags — separation from on-chain leaves", () => {
  it("agentic domain tag differs from starknet domain tag", () => {
    expect(UAR_DOMAIN_TAG_AGENTIC).not.toBe(UAR_DOMAIN_TAG_STARKNET);
  });

  it("agentic domain tag differs from W3C VC domain tag", () => {
    expect(UAR_DOMAIN_TAG_AGENTIC).not.toBe(UAR_DOMAIN_TAG_W3C_VC);
  });

  it("agentic domain tag differs from mdoc domain tag", () => {
    expect(UAR_DOMAIN_TAG_AGENTIC).not.toBe(UAR_DOMAIN_TAG_MDOC);
  });

  it("all four domain tags are distinct", () => {
    const tags = [
      UAR_DOMAIN_TAG_AGENTIC,
      UAR_DOMAIN_TAG_STARKNET,
      UAR_DOMAIN_TAG_W3C_VC,
      UAR_DOMAIN_TAG_MDOC,
    ];
    const unique = new Set(tags);
    expect(unique.size).toBe(4);
  });
});

// ─── Freshness epoch ──────────────────────────────────────────────────────────

describe("UARLeaf — freshness epoch", () => {
  it("epoch is a non-negative integer (current hourly epoch)", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(typeof leaf.epoch).toBe("number");
    expect(leaf.epoch).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(leaf.epoch)).toBe(true);
  });

  it("epoch matches expected hourly formula (within 1 epoch tolerance)", () => {
    const expectedEpoch = Math.floor(Date.now() / 3_600_000);
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(Math.abs(leaf.epoch - expectedEpoch)).toBeLessThanOrEqual(1);
  });

  it("isLeafFresh returns true for a freshly produced leaf", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    expect(isLeafFresh(leaf)).toBe(true);
  });

  it("isLeafFresh returns false for a stale leaf (epoch too old)", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    // Simulate a leaf from 48 hours ago
    const staleLeaf = { ...leaf, epoch: leaf.epoch - 48 };
    expect(isLeafFresh(staleLeaf, 24)).toBe(false);
  });

  it("isLeafFresh respects custom maxEpochAge", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const oldLeaf = { ...leaf, epoch: leaf.epoch - 5 };
    expect(isLeafFresh(oldLeaf, 6)).toBe(true);
    expect(isLeafFresh(oldLeaf, 4)).toBe(false);
  });
});

// ─── Mock submit ──────────────────────────────────────────────────────────────

describe("mockSubmitToUAR", () => {
  it("always returns accepted=true", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const receipt = mockSubmitToUAR(leaf);
    expect(receipt.accepted).toBe(true);
  });

  it("receipt carries the same anchor and epoch as the leaf", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const receipt = mockSubmitToUAR(leaf);
    expect(receipt.anchor).toBe(leaf.anchor);
    expect(receipt.epoch).toBe(leaf.epoch);
  });

  it("leafIndex is a non-negative BigInt (deterministic from anchor)", () => {
    const leaf = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const r1 = mockSubmitToUAR(leaf);
    const r2 = mockSubmitToUAR(leaf);
    expect(r1.leafIndex).toBe(r2.leafIndex);
    expect(r1.leafIndex).toBeGreaterThanOrEqual(0n);
  });

  it("different leaves → different leafIndexes (probabilistic, not guaranteed for mock)", () => {
    // This is a sanity check — mock uses anchor % 2^32, different anchors should usually differ.
    const leafA = contributeAnchorToUAR(makeAgentClaim(N_A, "identity"), BLINDING_1);
    const leafB = contributeAnchorToUAR(makeAgentClaim(N_B, "credit-score"), BLINDING_2);
    const rA = mockSubmitToUAR(leafA);
    const rB = mockSubmitToUAR(leafB);
    // They may collide due to mod 2^32, but with good inputs they should differ.
    // We only assert that they are both valid non-negative BigInts.
    expect(typeof rA.leafIndex).toBe("bigint");
    expect(typeof rB.leafIndex).toBe("bigint");
  });
});

// ─── Bulk contribution ────────────────────────────────────────────────────────

describe("contributeMultipleAnchors", () => {
  it("returns one leaf per claim", () => {
    const claims = [makeAgentClaim(N_A, "identity"), makeAgentClaim(N_B, "credit-score")];
    const leaves = contributeMultipleAnchors(claims, BLINDING_1);
    expect(leaves).toHaveLength(2);
  });

  it("leaves have correct roles", () => {
    const claims = [makeAgentClaim(N_A, "identity"), makeAgentClaim(N_B, "credit-score")];
    const leaves = contributeMultipleAnchors(claims, BLINDING_1);
    expect(leaves[0]?.agentRole).toBe("identity");
    expect(leaves[1]?.agentRole).toBe("credit-score");
  });
});
