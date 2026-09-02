/**
 * provableActionGate ; the preste local-before-action seam consuming decideProvably.
 *
 * Turns a deterministic allow/deny policy into an {@link ActionGate} whose verdict is a
 * governed, re-executable decision (ADR-ECO-092 / ADR-ECO-068). The minimal-loop dispatches
 * a tool only after `actionGate.verify(call)` allows it; here that verdict is produced by
 * `decideProvably`, so the gate decision itself grades A3 (an external party re-runs the
 * policy on the committed call and checks the output). Fail-closed: any error (e.g. a
 * non-deterministic policy raising GovernanceError) denies the call rather than throwing
 * into the loop.
 */
import type { ActionGate, ActionGateCall, ActionGateVerdict } from "../permissions/action-gate.js";
import { type DeterministicPolicy, decideProvably } from "./index.js";

/** The deterministic decision core a provable action gate commits. */
export interface GateDecisionCore {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Build an {@link ActionGate} from a pure allow/deny policy, governed by decideProvably.
 * The returned gate's verdict carries the governed audit step (host folds it into rootHash).
 */
export function provableActionGate(args: {
  policyId: string;
  policyVersion: string;
  adrEco: string;
  policy: DeterministicPolicy<ActionGateCall, GateDecisionCore>;
}): ActionGate {
  return {
    verify(call: ActionGateCall): ActionGateVerdict {
      try {
        const governed = decideProvably<ActionGateCall, GateDecisionCore>({
          policyId: args.policyId,
          policyVersion: args.policyVersion,
          policy: args.policy,
          input: call,
          adrEco: args.adrEco,
        });
        return {
          allowed: governed.claim.output.allowed,
          reason: governed.claim.output.reason,
          auditStep: governed.auditStep,
        };
      } catch (err) {
        // fail-closed: a governance/determinism error denies the call, never throws.
        const reason = err instanceof Error ? err.message : String(err);
        return { allowed: false, reason: `provable gate error (fail-closed): ${reason}` };
      }
    },
  };
}
