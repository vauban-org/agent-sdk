/**
 * src/mesh/attenuation.ts
 *
 * Biscuit-style capability attenuation for mesh.delegate().
 *
 * @deprecated Support module for `mesh/delegate.ts`, which has zero callers
 * in this monorepo as of 2026-07-05 (sprint-877 reconciliation). It
 * independently re-implements the same child-⊆-parent attenuation invariant
 * as `delegation/delegate.ts`'s `attenuate()` (ADR-ECO-076) with no shared
 * code. See the STATUS note atop `mesh/delegate.ts` before adding a new
 * dependency on this.
 *
 * Implements capability INTERSECTION (child ⊆ parent) without the actual
 * Biscuit token format — keeps the SDK dependency-free. Production deployments
 * should swap `buildToken` / `parseToken` for a real Biscuit issuer in CC.
 *
 * Invariants:
 *  - Child actions = INTERSECTION(parent.actions, requested.actions)
 *  - Child budget  = MIN(parent.budgetEur, requested.budgetEur)
 *  - Child expiry  = MIN(parent.expiresAt, requested.expiresAt) when both present
 *  - Wildcard support: "*" or "ns:*" in parent grants any matching action.
 *
 * No `any` — strict types per craft-standards.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * MeshCapabilityScope — bounded capability declaration for mesh dispatch.
 *
 * Renamed from `CapabilityScope` to avoid clash with `ports/delegation.ts`
 * which models a different (DelegationClaim) shape.
 * @public
 */
export interface MeshCapabilityScope {
  /** Actions permitted, e.g. ["brain:read", "vault:read", "hitl:trigger"]. */
  readonly actions: ReadonlyArray<string>;
  /** Max EUR the holder may spend under this scope. */
  readonly budgetEur: number;
  /** Hard expiry — past this date, scope MUST be rejected by callers. */
  readonly expiresAt?: Date;
}

/** Backwards-compatible alias for the spec name `CapabilityScope`. */
export type CapabilityScope = MeshCapabilityScope;

/**
 * AttenuatedToken — opaque transport for a scope across an agent boundary.
 *
 * Phase MVP : plain object (no signature). Phase 2+ : swap with Biscuit token
 * (the encoded `token` field becomes the Biscuit hex / base64 form).
 * @public
 */
export interface AttenuatedToken {
  /** Allowed actions (post-attenuation). */
  readonly scope: ReadonlyArray<string>;
  /** Remaining EUR allowance. */
  readonly budgetEur: number;
  /** Parent agent identifier — caller of the delegation step. */
  readonly parentId: string;
  /** Optional expiry, ISO 8601 — propagated from MeshCapabilityScope.expiresAt. */
  readonly expiresAt?: string;
}

// ─── Wildcard match ──────────────────────────────────────────────────────────

/**
 * Match an action against a parent permission entry.
 *
 *  - Exact match (case-sensitive).
 *  - `"*"` grants everything.
 *  - `"ns:*"` grants any action whose namespace prefix matches `ns:`.
 */
function permissionMatches(parentPerm: string, requested: string): boolean {
  if (parentPerm === "*" || parentPerm === requested) return true;
  if (parentPerm.endsWith(":*")) {
    const prefix = parentPerm.slice(0, -1); // keep trailing colon
    return requested.startsWith(prefix);
  }
  return false;
}

/**
 * Intersect a parent action set with a requested set.
 * Output: only requested actions that the parent allows (preserving order).
 */
function intersectActions(
  parent: ReadonlyArray<string>,
  requested: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const req of requested) {
    if (seen.has(req)) continue;
    for (const p of parent) {
      if (permissionMatches(p, req)) {
        out.push(req);
        seen.add(req);
        break;
      }
    }
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Attenuate a parent scope by a requested scope.
 *
 * Returns a NEW scope (immutable input semantics).
 * Guarantees `child ⊆ parent` (capability intersection invariant).
 * @public
 */
export function attenuateScope(
  parent: MeshCapabilityScope,
  requested: MeshCapabilityScope,
): MeshCapabilityScope {
  if (!Number.isFinite(parent.budgetEur) || parent.budgetEur < 0) {
    throw new RangeError(`attenuateScope: parent.budgetEur must be ≥ 0, got ${parent.budgetEur}`);
  }
  if (!Number.isFinite(requested.budgetEur) || requested.budgetEur < 0) {
    throw new RangeError(
      `attenuateScope: requested.budgetEur must be ≥ 0, got ${requested.budgetEur}`,
    );
  }

  const childActions = intersectActions(parent.actions, requested.actions);
  const childBudget = Math.min(parent.budgetEur, requested.budgetEur);

  let childExpiresAt: Date | undefined;
  if (parent.expiresAt && requested.expiresAt) {
    childExpiresAt = new Date(Math.min(parent.expiresAt.getTime(), requested.expiresAt.getTime()));
  } else if (parent.expiresAt) {
    childExpiresAt = new Date(parent.expiresAt.getTime());
  } else if (requested.expiresAt) {
    childExpiresAt = new Date(requested.expiresAt.getTime());
  }

  const out: MeshCapabilityScope = childExpiresAt
    ? {
        actions: childActions,
        budgetEur: childBudget,
        expiresAt: childExpiresAt,
      }
    : { actions: childActions, budgetEur: childBudget };
  return out;
}

/**
 * Check whether a scope permits a specific action.
 * Supports wildcards (`"*"`, `"ns:*"`). Returns false if scope is expired.
 * @public
 */
export function scopeAllows(scope: MeshCapabilityScope, action: string): boolean {
  if (scope.expiresAt && scope.expiresAt.getTime() <= Date.now()) return false;
  for (const perm of scope.actions) {
    if (permissionMatches(perm, action)) return true;
  }
  return false;
}

/**
 * Encode a scope as an opaque token bound to a parent identifier.
 *
 * Phase MVP : plain structural copy. Phase 2+ : replace with Biscuit-signed token
 * (the `parentId` becomes the issuer public key, `scope`/`budgetEur` become
 * Biscuit facts, `expiresAt` becomes a Biscuit check).
 * @public
 */
export function buildToken(scope: MeshCapabilityScope, parentId: string): AttenuatedToken {
  if (!parentId || typeof parentId !== "string") {
    throw new TypeError("buildToken: parentId must be a non-empty string");
  }
  const out: AttenuatedToken = scope.expiresAt
    ? {
        scope: [...scope.actions],
        budgetEur: scope.budgetEur,
        parentId,
        expiresAt: scope.expiresAt.toISOString(),
      }
    : { scope: [...scope.actions], budgetEur: scope.budgetEur, parentId };
  return out;
}

/**
 * Decode a token back to a MeshCapabilityScope.
 *
 * Inverse of `buildToken` modulo identity loss (parentId not part of scope).
 * @public
 */
export function parseToken(token: AttenuatedToken): MeshCapabilityScope {
  const out: MeshCapabilityScope = token.expiresAt
    ? {
        actions: [...token.scope],
        budgetEur: token.budgetEur,
        expiresAt: new Date(token.expiresAt),
      }
    : { actions: [...token.scope], budgetEur: token.budgetEur };
  return out;
}
