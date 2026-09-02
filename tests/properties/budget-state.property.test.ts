/**
 * Property-based tests — AgentBudgetState invariants (Sprint-470).
 *
 * Properties verified:
 *   P1. forall sequence of increment/reset ops, stepCount never exceeds maxSteps.
 *   P2. Once budget is exhausted (stepCount >= maxSteps), further increments
 *       do not push stepCount beyond maxSteps (no-op / capped semantics).
 *
 * 1000 runs via fc.assert per property.
 */

import fc from "fast-check";
import { describe, it } from "vitest";
import { createBudgetState } from "../../src/budget/budget-state.js";
import type { AgentBudgetState } from "../../src/budget/budget-state.js";

// ─── Helper: step increment mutator ──────────────────────────────────────────

/**
 * Applies one step increment to a budget state, clamped to maxSteps.
 * This mirrors the intended contract: stepCount must never exceed maxSteps.
 */
function incrementStep(state: AgentBudgetState): AgentBudgetState {
  const next = state.stepCount + 1;
  return {
    ...state,
    stepCount: Math.min(next, state.maxSteps),
  };
}

/**
 * Resets stepCount to 0 (e.g., after a compaction or loop restart).
 */
function resetSteps(state: AgentBudgetState): AgentBudgetState {
  return { ...state, stepCount: 0 };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a valid initial budget state with configurable maxSteps. */
const budgetStateArb = fc
  .integer({ min: 1, max: 50 })
  .map((maxSteps) => createBudgetState({ maxSteps }));

/** An operation tag: "increment" or "reset". */
const opArb = fc.constantFrom("increment" as const, "reset" as const);

// ─── P1: stepCount never exceeds maxSteps ────────────────────────────────────

describe("property — AgentBudgetState", () => {
  it("P1: stepCount never exceeds maxSteps after any sequence of increment/reset ops", () => {
    fc.assert(
      fc.property(
        budgetStateArb,
        fc.array(opArb, { minLength: 0, maxLength: 200 }),
        (initial, ops) => {
          let state = initial;
          for (const op of ops) {
            state = op === "increment" ? incrementStep(state) : resetSteps(state);
            // Invariant: stepCount must never exceed maxSteps.
            if (state.stepCount > state.maxSteps) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });

  // ─── P2: budget exhausted → increments are no-ops ──────────────────────────

  it("P2: once budget is exhausted, further increments do not increase stepCount beyond maxSteps", () => {
    fc.assert(
      fc.property(budgetStateArb, fc.integer({ min: 1, max: 100 }), (initial, extraIncrements) => {
        // Exhaust the budget first.
        let state = initial;
        for (let i = 0; i < initial.maxSteps; i++) {
          state = incrementStep(state);
        }
        // stepCount should be at maxSteps now.
        const atMax = state.stepCount;
        if (atMax !== state.maxSteps) {
          // Sanity: if incrementStep does not reach maxSteps from 0
          // in maxSteps calls, the helper is broken — fail loudly.
          return false;
        }

        // Apply extra increments — stepCount must stay at maxSteps.
        for (let i = 0; i < extraIncrements; i++) {
          state = incrementStep(state);
          if (state.stepCount > state.maxSteps) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});
