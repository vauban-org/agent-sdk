/**
 * Tests for privacy/composition — multi-agent recursive-AND ShieldedClaim.
 *
 * Validates:
 *   - Identity → credit-score → loan-approval E2E nominal (n=3)
 *   - n=2 flat (non-recursive) path
 *   - n=3 recursive path
 *   - n=5 deep recursion
 *   - Delegation chain integration with delegation.ts
 *   - Transcript binding (transcriptDigest changes if roles change)
 *   - Error cases (empty, single-agent, expired delegation)
 *   - Order-sensitivity (different orderings → different composedNullifier)
 *   - Payload merge (first agent wins on key conflicts)
 *
 * References:
 *   - docs/research/03-agentic-privacy.md §3 (Scenario 3: Multi-Agent Composition)
 *   - sprint-576:agentic-privacy-impl checkpoint 4 (ORQ-2)
 */

import { describe, expect, it } from "vitest";
import {
  type AgentClaim,
  CompositionError,
  type ShieldedClaim,
  buildAgentClaimWithDelegation,
  composeAgents,
} from "../src/privacy/composition.js";
import { deriveAgentNullifier } from "../src/privacy/nullifier.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MASTER_KEY = BigInt("0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabb");

// Three agent pubkeys for identity → credit → loan scenario
const PUBKEY_IDENTITY = BigInt("0x0101010101010101010101010101");
const PUBKEY_CREDIT = BigInt("0x0202020202020202020202020202");
const PUBKEY_LOAN = BigInt("0x0303030303030303030303030303");
const PUBKEY_D = BigInt("0x0404040404040404040404040404");
const PUBKEY_E = BigInt("0x0505050505050505050505050505");

const N_IDENTITY = deriveAgentNullifier(MASTER_KEY, PUBKEY_IDENTITY);
const N_CREDIT = deriveAgentNullifier(MASTER_KEY, PUBKEY_CREDIT);
const N_LOAN = deriveAgentNullifier(MASTER_KEY, PUBKEY_LOAN);
const N_D = deriveAgentNullifier(MASTER_KEY, PUBKEY_D);
const N_E = deriveAgentNullifier(MASTER_KEY, PUBKEY_E);

const FAR_FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 86400; // +24h
const PAST_EXPIRY = Math.floor(Date.now() / 1000) - 1;

function makeIdentityClaim(extra?: Record<string, unknown>): AgentClaim {
  return {
    agentNullifier: N_IDENTITY,
    role: "identity",
    payload: { predicate: "is-verified-human", issuer: "glacis-v1", ...extra },
  };
}

function makeCreditClaim(extra?: Record<string, unknown>): AgentClaim {
  return {
    agentNullifier: N_CREDIT,
    role: "credit-score",
    payload: { predicate: "credit-score-ok", score: 750, ...extra },
  };
}

function makeLoanClaim(extra?: Record<string, unknown>): AgentClaim {
  return {
    agentNullifier: N_LOAN,
    role: "loan-approval",
    payload: { predicate: "loan-approved", amount_eur: 10000, ...extra },
  };
}

// ─── n=2 flat path ────────────────────────────────────────────────────────────

describe("composeAgents — n=2 flat", () => {
  it("returns mode=flat for 2 agents", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(result.mode).toBe("flat");
    expect(result.n).toBe(2);
  });

  it("composedNullifier is a non-zero felt252 BigInt", () => {
    const FELT252_PRIME = BigInt(
      "3618502788666131213697322783095070105623107215331596699973092056135872020481",
    );
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(typeof result.composedNullifier).toBe("bigint");
    expect(result.composedNullifier).toBeGreaterThan(0n);
    expect(result.composedNullifier).toBeLessThan(FELT252_PRIME);
  });

  it("is deterministic — same inputs → same composedNullifier", () => {
    const r1 = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    const r2 = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(r1.composedNullifier).toBe(r2.composedNullifier);
    expect(r1.transcriptDigest).toBe(r2.transcriptDigest);
  });

  it("roles array matches input order", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(result.roles).toStrictEqual(["identity", "credit-score"]);
  });
});

// ─── n=3 recursive path ───────────────────────────────────────────────────────

describe("composeAgents — n=3 recursive (identity → credit → loan)", () => {
  it("returns mode=recursive for 3 agents", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    expect(result.mode).toBe("recursive");
    expect(result.n).toBe(3);
  });

  it("E2E nominal: identity → credit-score → loan-approval produces a valid ShieldedClaim", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    expect(result.composedNullifier).toBeGreaterThan(0n);
    expect(result.transcriptDigest).toBeGreaterThan(0n);
    expect(result.roles).toStrictEqual(["identity", "credit-score", "loan-approval"]);
    expect(result.n).toBe(3);
  });

  it("recursive composedNullifier differs from flat pairwise of first two", () => {
    const flatResult = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    const recursiveResult = composeAgents([
      makeIdentityClaim(),
      makeCreditClaim(),
      makeLoanClaim(),
    ]);
    // The recursive result must differ — adding a third agent changes the commitment.
    expect(recursiveResult.composedNullifier).not.toBe(flatResult.composedNullifier);
  });

  it("is deterministic", () => {
    const r1 = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    const r2 = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    expect(r1.composedNullifier).toBe(r2.composedNullifier);
    expect(r1.transcriptDigest).toBe(r2.transcriptDigest);
  });
});

// ─── n=5 deep recursion ───────────────────────────────────────────────────────

describe("composeAgents — n=5 deep recursion", () => {
  it("handles 5 agents and returns mode=recursive", () => {
    const agents: AgentClaim[] = [
      makeIdentityClaim(),
      makeCreditClaim(),
      makeLoanClaim(),
      { agentNullifier: N_D, role: "compliance", payload: { ok: true } },
      { agentNullifier: N_E, role: "audit", payload: { audited: true } },
    ];
    const result = composeAgents(agents);
    expect(result.mode).toBe("recursive");
    expect(result.n).toBe(5);
    expect(result.composedNullifier).toBeGreaterThan(0n);
    expect(result.roles).toHaveLength(5);
  });

  it("n=5 composedNullifier differs from n=3", () => {
    const r3 = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    const r5 = composeAgents([
      makeIdentityClaim(),
      makeCreditClaim(),
      makeLoanClaim(),
      { agentNullifier: N_D, role: "compliance", payload: {} },
      { agentNullifier: N_E, role: "audit", payload: {} },
    ]);
    expect(r5.composedNullifier).not.toBe(r3.composedNullifier);
  });
});

// ─── Order sensitivity ────────────────────────────────────────────────────────

describe("composeAgents — order sensitivity", () => {
  it("different orderings produce different composedNullifiers (order matters)", () => {
    const abc = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    const bac = composeAgents([makeCreditClaim(), makeIdentityClaim(), makeLoanClaim()]);
    expect(abc.composedNullifier).not.toBe(bac.composedNullifier);
  });

  it("different orderings produce different transcriptDigests", () => {
    const abc = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    const cba = composeAgents([makeLoanClaim(), makeCreditClaim(), makeIdentityClaim()]);
    expect(abc.transcriptDigest).not.toBe(cba.transcriptDigest);
  });
});

// ─── Transcript binding ───────────────────────────────────────────────────────

describe("composeAgents — transcript binding", () => {
  it("transcriptDigest changes when agent roles change", () => {
    const r1 = composeAgents([
      makeIdentityClaim(),
      { agentNullifier: N_CREDIT, role: "credit-score", payload: {} },
    ]);
    const r2 = composeAgents([
      makeIdentityClaim(),
      { agentNullifier: N_CREDIT, role: "different-role", payload: {} },
    ]);
    expect(r1.transcriptDigest).not.toBe(r2.transcriptDigest);
  });

  it("transcriptDigest is a non-zero felt252 BigInt", () => {
    const FELT252_PRIME = BigInt(
      "3618502788666131213697322783095070105623107215331596699973092056135872020481",
    );
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(result.transcriptDigest).toBeGreaterThan(0n);
    expect(result.transcriptDigest).toBeLessThan(FELT252_PRIME);
  });

  it("transcriptDigest differs from composedNullifier (domain separation)", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(result.transcriptDigest).not.toBe(result.composedNullifier);
  });
});

// ─── Payload merge ────────────────────────────────────────────────────────────

describe("composeAgents — payload merge", () => {
  it("merges payload from all agents", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim(), makeLoanClaim()]);
    expect(result.payload).toHaveProperty("predicate");
    expect(result.payload).toHaveProperty("score");
    expect(result.payload).toHaveProperty("amount_eur");
  });

  it("first agent wins on conflicting keys", () => {
    const a: AgentClaim = { agentNullifier: N_IDENTITY, role: "a", payload: { key: "A" } };
    const b: AgentClaim = { agentNullifier: N_CREDIT, role: "b", payload: { key: "B" } };
    const result = composeAgents([a, b]);
    expect(result.payload.key).toBe("A");
  });
});

// ─── Delegation chain integration ────────────────────────────────────────────

describe("composeAgents — delegation chain integration", () => {
  it("accepts claims with valid delegation chains", () => {
    const parentDigest = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
    const identityWithDelegation = buildAgentClaimWithDelegation(
      N_IDENTITY,
      "identity",
      { predicate: "is-verified-human" },
      parentDigest,
      { allowedActions: ["verify-identity"], expiry: FAR_FUTURE_EXPIRY },
    );
    const result = composeAgents([identityWithDelegation, makeCreditClaim()]);
    expect(result.delegationWitnesses.has("identity")).toBe(true);
    const witness = result.delegationWitnesses.get("identity");
    expect(witness).toBeDefined();
    expect(witness?.delegateePseudonym).toMatch(/^0x[0-9a-f]+$/);
  });

  it("delegation witness does not appear for agents without delegation", () => {
    const result = composeAgents([makeIdentityClaim(), makeCreditClaim()]);
    expect(result.delegationWitnesses.size).toBe(0);
  });

  it("multiple delegations — all witnesses preserved", () => {
    const parentDigest = [0xde, 0xad, 0xbe, 0xef];
    const a = buildAgentClaimWithDelegation(N_IDENTITY, "identity", {}, parentDigest, {
      allowedActions: ["*"],
      expiry: FAR_FUTURE_EXPIRY,
    });
    const b = buildAgentClaimWithDelegation(N_CREDIT, "credit-score", {}, parentDigest, {
      allowedActions: ["score"],
      expiry: FAR_FUTURE_EXPIRY,
    });
    const result = composeAgents([a, b]);
    expect(result.delegationWitnesses.size).toBe(2);
    expect(result.delegationWitnesses.has("identity")).toBe(true);
    expect(result.delegationWitnesses.has("credit-score")).toBe(true);
  });

  it("throws ExpiredDelegation when a delegation chain has expired", () => {
    const parentDigest = [0x11, 0x22, 0x33, 0x44];
    const expiredClaim = buildAgentClaimWithDelegation(N_IDENTITY, "identity", {}, parentDigest, {
      allowedActions: ["*"],
      expiry: PAST_EXPIRY,
    });
    expect(() => composeAgents([expiredClaim, makeCreditClaim()])).toThrow(CompositionError);
    expect(() => composeAgents([expiredClaim, makeCreditClaim()])).toThrow("expired");
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe("composeAgents — error cases", () => {
  it("throws EmptyComposition for empty array", () => {
    expect(() => composeAgents([])).toThrow(CompositionError);
    try {
      composeAgents([]);
    } catch (e) {
      expect((e as CompositionError).kind).toBe("EmptyComposition");
    }
  });

  it("throws SingleAgent for array of length 1", () => {
    expect(() => composeAgents([makeIdentityClaim()])).toThrow(CompositionError);
    try {
      composeAgents([makeIdentityClaim()]);
    } catch (e) {
      expect((e as CompositionError).kind).toBe("SingleAgent");
    }
  });
});
