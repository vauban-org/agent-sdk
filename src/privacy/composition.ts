/**
 * Multi-agent Claim composition — recursive-AND (∧) operator.
 *
 * Implements checkpoint 4 of sprint-576:agentic-privacy-impl (ORQ-2):
 * - `composeAgents(agents)` produces a recursive-AND ShieldedClaim over n≥2 agents.
 * - n=2: flat pairwise ∧ (no recursion needed).
 * - n≥3: left-fold recursive ∧ placeholder — future STARK aggregation via Stwo.
 *
 * Scenario: identity → credit-score → loan-approval (3 agents)
 *   1. Agent A: verifies identity (Glacis nullifier → pseudonym claim)
 *   2. Agent B: verifies credit (pseudonym + bank data → credit-score claim)
 *   3. Agent C: approves loan (credit-score claim → loan-approval claim)
 *   Composition: C_final = ((C_A ∧ C_B) ∧ C_C)
 *
 * References:
 *   - docs/research/03-agentic-privacy.md §3 (Scenario 3: Multi-Agent Composition)
 *   - docs/research/09-orq-recursive-starks.md §3 (recursive ∧ deferred to Phase 2)
 *   - vauban-privacy-protocol/sdk/typescript/src/composition.ts (compose operator pattern)
 *
 * @module privacy/composition
 */

import {
  type DelegationClaim,
  buildDelegationClaim,
  isDelegationScopeValid,
} from "./delegation.js";
import { feltMod, labelToFelt, poseidonHashBigInt } from "./poseidon-felt252.js";

// ─── Domain labels ────────────────────────────────────────────────────────────

const LABEL_COMPOSE_AND = labelToFelt("vauban-agent-compose-and-v1");
const LABEL_RECURSIVE = labelToFelt("vauban-recursive-and-v1");
const LABEL_TRANSCRIPT = labelToFelt("vauban-transcript-v1");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A claim produced by a single agent in a multi-agent workflow.
 *
 * Each `AgentClaim` carries its agent's nullifier (the cryptographic identity
 * of the agent in the HDNT hierarchy) and a role label describing its position
 * in the workflow (e.g. "identity", "credit-score", "loan-approval").
 *
 * The `delegationChain` is optional: when present, it anchors the agent's
 * claim to a parent claim via the Claim Algebra → operator.
 */
export interface AgentClaim {
  /** Agent's nullifier (felt252 BigInt). Output of `deriveAgentNullifier`. */
  agentNullifier: bigint;
  /** Role label for this agent in the workflow. Used for domain separation. */
  role: string;
  /** Arbitrary claim payload (predicate, evidence, etc.). */
  payload: Record<string, unknown>;
  /**
   * Optional delegation chain anchoring this claim to a parent.
   * When set, the composition will verify the delegation is still valid.
   */
  delegationChain?: DelegationClaim;
}

/**
 * The composition mode used for a given invocation of `composeAgents`.
 *
 * - `"flat"`: pairwise ∧ for n=2. Proofs are independent (checkpoint 3 style).
 * - `"recursive"`: left-fold recursive ∧ for n≥3. Phase 2 will replace the
 *   placeholder with actual Stwo STARK aggregation.
 */
export type CompositionMode = "flat" | "recursive";

/**
 * A ShieldedClaim produced by `composeAgents`.
 *
 * The `composedNullifier` is the binding commitment over all participating
 * agents' nullifiers — it changes if any agent is swapped out.
 *
 * The `transcriptDigest` binds the claim to the composition's public inputs
 * (ordered agent roles + composition mode) for external proof anchoring.
 */
export interface ShieldedClaim {
  /**
   * Poseidon-derived commitment over all agent nullifiers in order.
   * Different orderings → different composedNullifier (order matters).
   */
  composedNullifier: bigint;
  /** Merged payload from all agent claims (first agent wins on key conflicts). */
  payload: Record<string, unknown>;
  /** Agent roles in composition order. */
  roles: string[];
  /** Mode used ("flat" for n=2, "recursive" for n≥3). */
  mode: CompositionMode;
  /**
   * Transcript digest: Poseidon(composedNullifier, rolesFelt, LABEL_TRANSCRIPT).
   * Binds the ShieldedClaim to its public inputs for proof anchoring (ORQ-5).
   */
  transcriptDigest: bigint;
  /**
   * Delegation witnesses for any claims that had a `delegationChain`.
   * Keyed by role label. Empty if no delegations were present.
   */
  delegationWitnesses: Map<string, DelegationClaim>;
  /** Number of agents composed. */
  n: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Error thrown by `composeAgents` on invalid input or constraint violation.
 */
export class CompositionError extends Error {
  readonly kind: "EmptyComposition" | "ExpiredDelegation" | "SingleAgent";

  constructor(kind: "EmptyComposition" | "ExpiredDelegation" | "SingleAgent", message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = "CompositionError";
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Encode an array of role strings as a single felt252 for use in the
 * transcript digest. Roles are XOR-folded with their position index to
 * preserve ordering (different orderings → different felt).
 */
function rolesToFelt(roles: string[]): bigint {
  let acc = 0n;
  for (let i = 0; i < roles.length; i++) {
    const roleFelt = labelToFelt(roles[i] ?? "");
    // Mix role felt with position to make ordering matter.
    acc = feltMod(acc ^ (roleFelt + BigInt(i + 1) * 0x1b1b1b1bn));
  }
  return acc;
}

/**
 * Pairwise ∧: combine two agent nullifiers into a composed nullifier.
 * Poseidon(a, b, LABEL_COMPOSE_AND) — order-sensitive by construction.
 */
function composePair(aNullifier: bigint, bNullifier: bigint): bigint {
  return poseidonHashBigInt([feltMod(aNullifier), feltMod(bNullifier), LABEL_COMPOSE_AND]);
}

/**
 * Recursive-AND placeholder for n≥3.
 *
 * Left-fold: ((a ∧ b) ∧ c) ∧ d … with LABEL_RECURSIVE to domain-separate
 * from flat ∧. Phase 2 replaces this with Stwo STARK aggregation proof.
 *
 * TODO (ORQ-2, Phase 2): Replace with real recursive STARK aggregation via Stwo.
 */
function composeRecursive(nullifiers: bigint[]): bigint {
  // Seed: Poseidon(first, second, LABEL_RECURSIVE)
  let acc = poseidonHashBigInt([
    feltMod(nullifiers[0] ?? 0n),
    feltMod(nullifiers[1] ?? 0n),
    LABEL_RECURSIVE,
  ]);
  // Fold in remaining nullifiers.
  for (let i = 2; i < nullifiers.length; i++) {
    acc = poseidonHashBigInt([acc, feltMod(nullifiers[i] ?? 0n), LABEL_RECURSIVE]);
  }
  return acc;
}

/**
 * Merge payloads from all agents (left-to-right, first agent wins on conflict).
 */
function mergePayloads(claims: AgentClaim[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  // Iterate in reverse so first agent wins (earlier keys overwrite later).
  for (let i = claims.length - 1; i >= 0; i--) {
    const payload = claims[i]?.payload ?? {};
    for (const [k, v] of Object.entries(payload)) {
      merged[k] = v;
    }
  }
  return merged;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compose n≥2 AgentClaims into a single recursive-AND ShieldedClaim.
 *
 * Algorithm:
 *   - n=2: flat pairwise ∧ (Poseidon(a, b, LABEL_AND)).
 *   - n≥3: left-fold recursive ∧ (Poseidon accumulator with LABEL_RECURSIVE).
 *
 * If any agent claim carries a `delegationChain`, its validity is checked
 * (expiry). Expired delegations cause an `ExpiredDelegation` error.
 *
 * The `transcriptDigest` binds the result to the ordered list of roles and
 * the composedNullifier for external proof anchoring.
 *
 * Example (identity → credit-score → loan-approval, n=3):
 * ```ts
 * const result = composeAgents([identityClaim, creditClaim, loanClaim]);
 * // result.mode === "recursive"
 * // result.n === 3
 * // result.roles === ["identity", "credit-score", "loan-approval"]
 * ```
 *
 * @param agents - Ordered list of AgentClaims (at least 2).
 * @returns ShieldedClaim with composedNullifier, transcriptDigest, and merged payload.
 * @throws {CompositionError} EmptyComposition if agents is empty.
 * @throws {CompositionError} SingleAgent if only 1 agent is provided.
 * @throws {CompositionError} ExpiredDelegation if any delegation chain has expired.
 */
export function composeAgents(agents: AgentClaim[]): ShieldedClaim {
  if (agents.length === 0) {
    throw new CompositionError("EmptyComposition", "composeAgents requires at least 2 agents");
  }
  if (agents.length === 1) {
    throw new CompositionError("SingleAgent", "composeAgents requires at least 2 agents, got 1");
  }

  // Validate delegation chains.
  const delegationWitnesses = new Map<string, DelegationClaim>();
  for (const agent of agents) {
    if (agent.delegationChain !== undefined) {
      if (!isDelegationScopeValid(agent.delegationChain.scope)) {
        throw new CompositionError(
          "ExpiredDelegation",
          `delegation for role "${agent.role}" has expired`,
        );
      }
      delegationWitnesses.set(agent.role, agent.delegationChain);
    }
  }

  const nullifiers = agents.map((a) => a.agentNullifier);
  const roles = agents.map((a) => a.role);
  const n = agents.length;

  // Compose nullifiers.
  const mode: CompositionMode = n === 2 ? "flat" : "recursive";
  const composedNullifier =
    mode === "flat"
      ? composePair(nullifiers[0] ?? 0n, nullifiers[1] ?? 0n)
      : composeRecursive(nullifiers);

  // Transcript digest — binds composedNullifier + ordered roles + domain label.
  const rolesFelt = rolesToFelt(roles);
  const transcriptDigest = poseidonHashBigInt([composedNullifier, rolesFelt, LABEL_TRANSCRIPT]);

  // Merge payloads.
  const payload = mergePayloads(agents);

  return {
    composedNullifier,
    payload,
    roles,
    mode,
    transcriptDigest,
    delegationWitnesses,
    n,
  };
}

/**
 * Build an AgentClaim with an attached DelegationClaim.
 *
 * Convenience factory that calls `buildDelegationClaim` from `delegation.ts`
 * and wires the result into an `AgentClaim.delegationChain`.
 *
 * @param agentNullifier     - Derived nullifier of this agent.
 * @param role               - Workflow role label.
 * @param payload            - Claim payload.
 * @param parentClaimDigest  - Parent claim digest bytes (from the authorizing claim).
 * @param scope              - Delegation scope (allowed actions + expiry).
 * @returns AgentClaim with populated delegationChain.
 */
export function buildAgentClaimWithDelegation(
  agentNullifier: bigint,
  role: string,
  payload: Record<string, unknown>,
  parentClaimDigest: number[],
  scope: { allowedActions: string[]; expiry: number },
): AgentClaim {
  const delegation = buildDelegationClaim(
    { digest: parentClaimDigest, "digest-alg": "poseidon-felt252" },
    agentNullifier,
    scope,
  );
  return { agentNullifier, role, payload, delegationChain: delegation };
}
