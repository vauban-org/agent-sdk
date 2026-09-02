/**
 * compute/battery/action-gate.ts
 *
 * batteryActionGate ; adapt a VerifierBattery into an {@link ActionGate} so the
 * agent loop can gate every tool call BEFORE it acts (local-before-action). The
 * proposed call becomes the single candidate; the governed lenses judge it; the
 * loop is allowed to proceed only when the battery accepts (fail-closed: a killed
 * candidate denies the action). The battery's hash-only audit step is returned on
 * the verdict for the host to fold into its trace rootHash.
 *
 * This is the seam where the governed-primitives suite becomes a runtime control:
 * the loop sees only the ActionGate interface (permissions/action-gate.ts); the
 * coupling to VerifierBattery lives here.
 *
 * @module compute/battery/action-gate
 */

import type {
  ActionGate,
  ActionGateCall,
  ActionGateVerdict,
} from "../../permissions/action-gate.js";
import type { ClockPort } from "../../replay/clock.js";
import { runVerifierBattery } from "./battery.js";
import type { BatteryLens } from "./types.js";

/** @public */
export interface BatteryActionGateOptions<TCandidate> {
  /** Governed lenses that judge the proposed action (at least one deterministic anchor). */
  readonly lenses: readonly BatteryLens<TCandidate>[];
  /** Governing ADR-ECO, forwarded to the battery (mandatory, cargo-cult guard). */
  readonly adrEco: string;
  /** Clock for the audit step. Use RealClock in production, RecordedClock for replay. */
  readonly clock: ClockPort;
  /** Map a proposed call into the candidate the lenses evaluate. Default: the call object. */
  readonly project?: (call: ActionGateCall) => TCandidate;
  readonly voteThreshold?: number;
  /** Run id stamped on the audit step. Default "battery-action-gate"; pass the loop run id. */
  readonly runId?: string;
}

/**
 * Build an {@link ActionGate} backed by a VerifierBattery. Allowed iff the battery
 * accepts a candidate; otherwise denied fail-closed with the kept reject reasons.
 * @public
 */
export function batteryActionGate<TCandidate = ActionGateCall>(
  opts: BatteryActionGateOptions<TCandidate>,
): ActionGate {
  const project = opts.project ?? ((c: ActionGateCall) => c as unknown as TCandidate);
  const runId = opts.runId ?? "battery-action-gate";

  return {
    async verify(call: ActionGateCall): Promise<ActionGateVerdict> {
      const decision = await runVerifierBattery<TCandidate>(call, [project(call)], opts.lenses, {
        clock: opts.clock,
        runId,
        adrEco: opts.adrEco,
        voteThreshold: opts.voteThreshold,
      });
      // Gate on acceptedIndex (the survivor signal), not accepted (the candidate
      // VALUE, which can legitimately be null): a surviving null candidate must
      // not be mislabelled "all candidates killed". Fail-closed direction unchanged.
      if (decision.acceptedIndex !== null) {
        return {
          allowed: true,
          reason: "action allowed (battery accepted)",
          auditStep: decision.auditStep,
        };
      }
      const why = decision.rejected.map((r) => r.reason).join("; ") || "all candidates killed";
      return {
        allowed: false,
        reason: `action denied (battery): ${why}`,
        auditStep: decision.auditStep,
      };
    },
  };
}
