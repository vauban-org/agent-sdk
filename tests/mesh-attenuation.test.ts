/**
 * tests/mesh-attenuation.test.ts
 *
 * sprint-585 — capability attenuation invariants.
 *
 * Covers:
 *  - attenuateScope: action intersection, budget min, expiry min, wildcards
 *  - scopeAllows: wildcard matching, expiry guard
 *  - buildToken: shape, parentId binding, ISO expiry serialisation
 *  - parseToken: round-trip with buildToken, no-expiry path
 */

import { describe, expect, it } from "vitest";
import {
  type AttenuatedToken,
  type MeshCapabilityScope,
  attenuateScope,
  buildToken,
  parseToken,
  scopeAllows,
} from "../src/mesh/attenuation.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 3_600_000); // +1 hour
const PAST = new Date(Date.now() - 3_600_000); // -1 hour

function mkScope(actions: string[], budgetEur: number, expiresAt?: Date): MeshCapabilityScope {
  return expiresAt ? { actions, budgetEur, expiresAt } : { actions, budgetEur };
}

// ─── attenuateScope — action intersection ────────────────────────────────────

describe("mesh.attenuateScope — action intersection", () => {
  it("intersects parent and requested action sets", () => {
    const parent: MeshCapabilityScope = {
      actions: ["brain:read", "vault:write"],
      budgetEur: 1.0,
    };
    const requested: MeshCapabilityScope = {
      actions: ["vault:write", "starknet:sign"],
      budgetEur: 0.5,
    };
    const child = attenuateScope(parent, requested);
    expect(child.actions).toEqual(["vault:write"]);
  });

  it("empty intersection produces empty child actions", () => {
    const child = attenuateScope(mkScope(["brain:read"], 10), mkScope(["vault:write"], 10));
    expect(child.actions).toHaveLength(0);
  });

  it("expands no further than parent — invariant child ⊆ parent", () => {
    const parent: MeshCapabilityScope = {
      actions: ["read"],
      budgetEur: 0.01,
    };
    const requested: MeshCapabilityScope = {
      actions: ["read", "write", "admin"],
      budgetEur: 100,
    };
    const child = attenuateScope(parent, requested);
    expect(child.actions).toEqual(["read"]);
    expect(child.budgetEur).toBe(0.01);
  });

  it("supports wildcard '*' in parent — grants every requested action", () => {
    const parent: MeshCapabilityScope = { actions: ["*"], budgetEur: 1 };
    const requested: MeshCapabilityScope = {
      actions: ["brain:read", "starknet:sign"],
      budgetEur: 0.5,
    };
    const child = attenuateScope(parent, requested);
    expect(child.actions).toEqual(["brain:read", "starknet:sign"]);
  });

  it("supports namespace wildcard 'ns:*' — grants same-ns actions only", () => {
    const parent: MeshCapabilityScope = { actions: ["brain:*"], budgetEur: 1 };
    const requested: MeshCapabilityScope = {
      actions: ["brain:read", "brain:write", "vault:read"],
      budgetEur: 1,
    };
    const child = attenuateScope(parent, requested);
    expect(child.actions).toEqual(["brain:read", "brain:write"]);
  });

  it("'ns:*' does NOT grant actions in a different namespace", () => {
    const child = attenuateScope(
      mkScope(["brain:*"], 10),
      mkScope(["vault:read", "brain:read"], 10),
    );
    expect(child.actions).toEqual(["brain:read"]);
  });

  it("exact match is case-sensitive (Brain:Read ≠ brain:read)", () => {
    const child = attenuateScope(mkScope(["Brain:Read"], 10), mkScope(["brain:read"], 10));
    expect(child.actions).toHaveLength(0);
  });

  it("multiple wildcards — 'brain:*' + 'vault:*' each grant their namespace", () => {
    const child = attenuateScope(
      mkScope(["brain:*", "vault:*"], 20),
      mkScope(["brain:read", "vault:write", "hitl:trigger"], 20),
    );
    expect(child.actions).toEqual(["brain:read", "vault:write"]);
  });

  it("partial intersection — requested order is preserved for matched items", () => {
    const child = attenuateScope(mkScope(["a", "b", "c"], 10), mkScope(["c", "d", "a"], 10));
    expect(child.actions).toEqual(["c", "a"]);
  });

  it("duplicate requested actions are de-duplicated in output", () => {
    const child = attenuateScope(
      mkScope(["brain:read"], 10),
      mkScope(["brain:read", "brain:read"], 10),
    );
    expect(child.actions).toHaveLength(1);
    expect(child.actions[0]).toBe("brain:read");
  });
});

// ─── attenuateScope — budget invariant ───────────────────────────────────────

describe("mesh.attenuateScope — budget invariant", () => {
  it("attenuates budget to MIN(parent, requested) — parent smaller", () => {
    const parent: MeshCapabilityScope = { actions: ["*"], budgetEur: 0.05 };
    const requested: MeshCapabilityScope = { actions: ["any"], budgetEur: 0.1 };
    const child = attenuateScope(parent, requested);
    expect(child.budgetEur).toBe(0.05);
  });

  it("child budget capped at parent even when requested is much higher", () => {
    const child = attenuateScope(mkScope(["*"], 100), mkScope(["*"], 9999));
    expect(child.budgetEur).toBe(100);
  });

  it("child budget = requested when requested is smaller", () => {
    const child = attenuateScope(mkScope(["*"], 50), mkScope(["*"], 10));
    expect(child.budgetEur).toBe(10);
  });

  it("zero budget from MIN — child cannot spend anything", () => {
    const child = attenuateScope(mkScope(["*"], 0), mkScope(["*"], 100));
    expect(child.budgetEur).toBe(0);
  });

  it("rejects negative parent budget with RangeError", () => {
    expect(() =>
      attenuateScope({ actions: ["x"], budgetEur: -1 }, { actions: ["x"], budgetEur: 1 }),
    ).toThrow(RangeError);
  });

  it("rejects negative requested budget with RangeError", () => {
    expect(() => attenuateScope(mkScope(["*"], 10), mkScope(["*"], -5))).toThrow(RangeError);
  });
});

// ─── attenuateScope — expiry invariant ───────────────────────────────────────

describe("mesh.attenuateScope — expiry invariant", () => {
  it("uses earliest expiry when both scopes have one", () => {
    const earlier = new Date("2030-01-01T00:00:00Z");
    const later = new Date("2031-01-01T00:00:00Z");
    const child1 = attenuateScope(
      { actions: ["x"], budgetEur: 1, expiresAt: earlier },
      { actions: ["x"], budgetEur: 1, expiresAt: later },
    );
    expect(child1.expiresAt?.getTime()).toBe(earlier.getTime());
    const child2 = attenuateScope(
      { actions: ["x"], budgetEur: 1, expiresAt: later },
      { actions: ["x"], budgetEur: 1, expiresAt: earlier },
    );
    expect(child2.expiresAt?.getTime()).toBe(earlier.getTime());
  });

  it("only parent has expiry — child inherits parent expiry", () => {
    const child = attenuateScope(mkScope(["*"], 10, FUTURE), mkScope(["*"], 10));
    expect(child.expiresAt?.getTime()).toBe(FUTURE.getTime());
  });

  it("only requested has expiry — child gets requested expiry", () => {
    const child = attenuateScope(mkScope(["*"], 10), mkScope(["*"], 10, FUTURE));
    expect(child.expiresAt?.getTime()).toBe(FUTURE.getTime());
  });

  it("neither scope has expiry — child has no expiry", () => {
    const child = attenuateScope(mkScope(["*"], 10), mkScope(["*"], 10));
    expect(child.expiresAt).toBeUndefined();
  });
});

// ─── scopeAllows ──────────────────────────────────────────────────────────────

describe("mesh.scopeAllows", () => {
  it("returns true for exact match", () => {
    const s: MeshCapabilityScope = { actions: ["vault:read"], budgetEur: 1 };
    expect(scopeAllows(s, "vault:read")).toBe(true);
  });

  it("returns false for unmatched action", () => {
    const s: MeshCapabilityScope = { actions: ["vault:read"], budgetEur: 1 };
    expect(scopeAllows(s, "vault:write")).toBe(false);
  });

  it("returns true for wildcard '*'", () => {
    const s: MeshCapabilityScope = { actions: ["*"], budgetEur: 1 };
    expect(scopeAllows(s, "anything:goes")).toBe(true);
  });

  it("returns true for ns:* match and false for cross-namespace", () => {
    const s: MeshCapabilityScope = { actions: ["brain:*"], budgetEur: 1 };
    expect(scopeAllows(s, "brain:read")).toBe(true);
    expect(scopeAllows(s, "vault:read")).toBe(false);
  });

  it("returns false when scope is expired (expiresAt in the past)", () => {
    const s: MeshCapabilityScope = {
      actions: ["*"],
      budgetEur: 1,
      expiresAt: PAST,
    };
    expect(scopeAllows(s, "anything")).toBe(false);
  });

  it("returns true for non-expired scope", () => {
    const s: MeshCapabilityScope = {
      actions: ["brain:read"],
      budgetEur: 1,
      expiresAt: FUTURE,
    };
    expect(scopeAllows(s, "brain:read")).toBe(true);
  });
});

// ─── buildToken ───────────────────────────────────────────────────────────────

describe("mesh.buildToken", () => {
  it("token.scope equals scope.actions", () => {
    const s = mkScope(["brain:read", "vault:read"], 20, FUTURE);
    const token = buildToken(s, "agent-abc");
    expect(token.scope).toEqual(["brain:read", "vault:read"]);
  });

  it("token.budgetEur equals scope.budgetEur", () => {
    const s = mkScope(["*"], 42);
    const token = buildToken(s, "agent-xyz");
    expect(token.budgetEur).toBe(42);
  });

  it("token.parentId matches the provided agentId", () => {
    const s = mkScope(["brain:read"], 10);
    const token = buildToken(s, "my-parent-agent");
    expect(token.parentId).toBe("my-parent-agent");
  });

  it("token.expiresAt is ISO 8601 string when scope has expiresAt", () => {
    const fixed = new Date("2030-01-01T00:00:00Z");
    const s = mkScope(["*"], 10, fixed);
    const token = buildToken(s, "agent-1");
    expect(token.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("token.expiresAt is undefined when scope has no expiresAt", () => {
    const s = mkScope(["*"], 10);
    const token = buildToken(s, "agent-1");
    expect(token.expiresAt).toBeUndefined();
  });

  it("throws TypeError for empty parentId string", () => {
    expect(() => buildToken(mkScope(["*"], 10), "")).toThrow(TypeError);
  });
});

// ─── parseToken ───────────────────────────────────────────────────────────────

describe("mesh.buildToken / parseToken", () => {
  it("round-trips a scope with expiry", () => {
    const s: MeshCapabilityScope = {
      actions: ["brain:read", "vault:read"],
      budgetEur: 0.25,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    };
    const token = buildToken(s, "agent-parent-1");
    expect(token.parentId).toBe("agent-parent-1");
    expect(token.scope).toEqual(["brain:read", "vault:read"]);
    expect(token.budgetEur).toBe(0.25);
    expect(token.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    const back = parseToken(token);
    expect(back.actions).toEqual(s.actions);
    expect(back.budgetEur).toBe(s.budgetEur);
    expect(back.expiresAt?.getTime()).toBe(s.expiresAt?.getTime());
  });

  it("round-trips a scope without expiry", () => {
    const s = mkScope(["*"], 10);
    const token = buildToken(s, "agent-no-exp");
    const recovered = parseToken(token);
    expect(recovered.actions).toEqual(["*"]);
    expect(recovered.budgetEur).toBe(10);
    expect(recovered.expiresAt).toBeUndefined();
  });

  it("parseToken returns MeshCapabilityScope with actions from token.scope", () => {
    const token: AttenuatedToken = {
      scope: ["a:1", "b:2"],
      budgetEur: 5,
      parentId: "p1",
    };
    const s = parseToken(token);
    expect(s.actions).toEqual(["a:1", "b:2"]);
    expect(s.budgetEur).toBe(5);
  });

  it("parsed scope can be used directly in scopeAllows", () => {
    const original = mkScope(["brain:read"], 10, FUTURE);
    const token = buildToken(original, "agent-sa");
    const recovered = parseToken(token);
    expect(scopeAllows(recovered, "brain:read")).toBe(true);
    expect(scopeAllows(recovered, "vault:write")).toBe(false);
  });

  it("rejects empty parentId", () => {
    expect(() => buildToken({ actions: ["x"], budgetEur: 1 }, "")).toThrow(TypeError);
  });
});
