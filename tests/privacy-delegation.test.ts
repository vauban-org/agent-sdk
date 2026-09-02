/**
 * Tests for privacy/delegation — Delegation-as-Claim skeleton.
 *
 * Validates requirements from vauban-privacy-protocol/docs/research/03-agentic-privacy.md §3:
 *   - Scope serialization is deterministic (JCS-compatible sorted JSON).
 *   - Expiry enforcement: expired scopes are rejected.
 *   - Allowed-action filter: only listed actions (or wildcard) pass.
 */

import { describe, expect, it } from "vitest";
import {
  type ClaimRef,
  type DelegationScope,
  buildDelegationClaim,
  isActionAllowed,
  isDelegationScopeValid,
  serializeDelegationScope,
} from "../src/privacy/delegation.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PARENT_CLAIM_REF: ClaimRef = {
  digest: [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04],
  "digest-alg": "sha-256",
};

const DELEGATEE_PSEUDONYM = BigInt("0x1234567890abcdef");

const FAR_FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 86400; // +24 h
const PAST_EXPIRY = Math.floor(Date.now() / 1000) - 1; // 1 second ago

// ─── serializeDelegationScope tests ──────────────────────────────────────────

describe("serializeDelegationScope", () => {
  it("serializes a scope to deterministic JSON (actions sorted)", () => {
    const scope: DelegationScope = {
      allowedActions: ["trade", "approve"],
      expiry: 1700000000,
    };
    const wire = serializeDelegationScope(scope);
    // Actions should be sorted
    expect(wire).toBe(JSON.stringify({ allowedActions: ["approve", "trade"], expiry: 1700000000 }));
  });

  it("produces identical output regardless of input action order", () => {
    const scopeA: DelegationScope = {
      allowedActions: ["z-action", "a-action"],
      expiry: 9999999999,
    };
    const scopeB: DelegationScope = {
      allowedActions: ["a-action", "z-action"],
      expiry: 9999999999,
    };
    expect(serializeDelegationScope(scopeA)).toBe(serializeDelegationScope(scopeB));
  });

  it("encodes expiry as a number (not a string)", () => {
    const scope: DelegationScope = { allowedActions: ["*"], expiry: 1234567890 };
    const wire = serializeDelegationScope(scope);
    const parsed = JSON.parse(wire) as { expiry: unknown };
    expect(typeof parsed.expiry).toBe("number");
  });
});

// ─── isDelegationScopeValid tests ─────────────────────────────────────────────

describe("isDelegationScopeValid", () => {
  it("returns true when expiry is in the future", () => {
    const scope: DelegationScope = { allowedActions: ["*"], expiry: FAR_FUTURE_EXPIRY };
    expect(isDelegationScopeValid(scope)).toBe(true);
  });

  it("returns false when expiry is in the past", () => {
    const scope: DelegationScope = { allowedActions: ["*"], expiry: PAST_EXPIRY };
    expect(isDelegationScopeValid(scope)).toBe(false);
  });

  it("enforces expiry against a custom nowSec argument", () => {
    const expiry = 1000;
    const scope: DelegationScope = { allowedActions: ["trade"], expiry };
    expect(isDelegationScopeValid(scope, 999)).toBe(true);
    expect(isDelegationScopeValid(scope, 1000)).toBe(false); // strict <
    expect(isDelegationScopeValid(scope, 1001)).toBe(false);
  });
});

// ─── isActionAllowed tests ────────────────────────────────────────────────────

describe("isActionAllowed", () => {
  it("allows a listed action", () => {
    const scope: DelegationScope = {
      allowedActions: ["trade", "report"],
      expiry: FAR_FUTURE_EXPIRY,
    };
    expect(isActionAllowed(scope, "trade")).toBe(true);
    expect(isActionAllowed(scope, "report")).toBe(true);
  });

  it("denies an action not in the allowlist", () => {
    const scope: DelegationScope = {
      allowedActions: ["trade"],
      expiry: FAR_FUTURE_EXPIRY,
    };
    expect(isActionAllowed(scope, "sign-tx")).toBe(false);
  });

  it('wildcard ["*"] allows any action', () => {
    const scope: DelegationScope = {
      allowedActions: ["*"],
      expiry: FAR_FUTURE_EXPIRY,
    };
    expect(isActionAllowed(scope, "anything")).toBe(true);
    expect(isActionAllowed(scope, "sign-tx")).toBe(true);
    expect(isActionAllowed(scope, "some-exotic-op")).toBe(true);
  });
});

// ─── buildDelegationClaim integration tests ───────────────────────────────────

describe("buildDelegationClaim", () => {
  it("returns a DelegationClaim with all required fields", () => {
    const scope: DelegationScope = {
      allowedActions: ["trade"],
      expiry: FAR_FUTURE_EXPIRY,
    };
    const claim = buildDelegationClaim(PARENT_CLAIM_REF, DELEGATEE_PSEUDONYM, scope);

    expect(claim.parentClaim).toStrictEqual(PARENT_CLAIM_REF);
    expect(claim.delegateePseudonym).toMatch(/^0x[0-9a-f]+$/);
    expect(claim.scope).toStrictEqual(scope);
    expect(claim.issuedAt).toBeTruthy();
    expect(claim.scopeWitness).toBe(serializeDelegationScope(scope));
  });

  it("encodes delegatee pseudonym as lowercase hex with 0x prefix", () => {
    const scope: DelegationScope = { allowedActions: ["*"], expiry: FAR_FUTURE_EXPIRY };
    const claim = buildDelegationClaim(PARENT_CLAIM_REF, BigInt("0xABCDEF"), scope);
    expect(claim.delegateePseudonym).toBe(`0x${BigInt("0xABCDEF").toString(16)}`);
    expect(claim.delegateePseudonym).toMatch(/^0x[0-9a-f]+$/); // lowercase
  });
});
