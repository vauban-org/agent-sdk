/**
 * permissions/action-gate.ts
 *
 * ActionGate ; a pre-action governance gate for the agent loop, run BEFORE every
 * tool call (after the capability gate). It mirrors the CapabilityGate contract:
 * an injected interface the host wires, so the loop stays decoupled from any
 * concrete verifier. A denied verdict skips the call fail-closed (the loop
 * continues with the next call, no panic), exactly like a capability deny.
 *
 * The canonical backing is a VerifierBattery: see compute/battery/action-gate.ts
 * `batteryActionGate()`, which turns a set of governed lenses into an ActionGate
 * (local-before-action). The loop never imports the battery; it only sees this
 * interface.
 *
 * @module permissions/action-gate
 */

/**
 * The proposed tool call presented to the gate before dispatch.
 * @public
 */
export interface ActionGateCall {
  readonly toolName: string;
  readonly args: unknown;
  /** Accumulated per-loop budget already spent (USD), for budget-aware lenses. */
  readonly budgetUsed: number;
}

/**
 * The gate's verdict on one proposed call.
 * @public
 */
export interface ActionGateVerdict {
  /** When false, the loop skips the call fail-closed. */
  readonly allowed: boolean;
  /** Human-readable reason (Art. 14), surfaced in the tool log + deny event. */
  readonly reason: string;
  /**
   * Optional denial-class discriminator, e.g. "posture_denied" (ADR-ECO-135).
   * Surfaced verbatim as the `ERROR:` prefix in place of the default
   * "action_denied", and threaded into {@link ActionGateVerdict}'s deny
   * event so a host can tell one denying gate's verdict from another's
   * without parsing `reason`. Absent = today's "action_denied" prefix,
   * byte-identical for every existing gate. Opaque to the loop: it never
   * branches on the string, only forwards it.
   */
  readonly kind?: string;
  /**
   * Optional audit step the host folds into its trace rootHash (e.g. the
   * VerifierBattery's hash-only guard step). Opaque to the loop.
   */
  readonly auditStep?: unknown;
}

/**
 * Host-injected pre-action gate. May be sync or async.
 * @public
 */
export interface ActionGate {
  verify(call: ActionGateCall): Promise<ActionGateVerdict> | ActionGateVerdict;
}

/**
 * Fail-closed AND-composition of two or more {@link ActionGate}s, on the
 * interface only (no coupling to any concrete backing). Realises the
 * ADR-ECO-092 clause "seam loop/minimal-loop.ts actionGate compose avec
 * batteryActionGate": one composed gate the loop injects through its existing
 * `actionGate?` seam, that ANDs an arbitrary set of governed gates ; e.g.
 * `composeActionGates(provableActionGate(...), batteryActionGate(...))`.
 *
 * Semantics (all three are load-bearing for governance):
 *  - ALL gates are evaluated for every call ; the composition does NOT
 *    short-circuit on the first deny. Each gate's governed audit step is
 *    therefore always produced, so the host can fold every one into its trace
 *    rootHash (governed-primitives.md seam invariant: one audit step per gate).
 *  - The composite ALLOWS iff EVERY gate allows ; it DENIES if ANY gate denies
 *    (fail-closed AND). The loop then skips the tool call, exactly as for a
 *    single denying gate.
 *  - A gate that THROWS is treated as a deny (fail-closed), never propagated
 *    into the loop ; its failure is recorded in the composite reason. This
 *    mirrors the loop's own `catch` and the battery / provable backings.
 *
 * The returned verdict's `auditStep` is the array of every sub-gate audit step
 * that was defined (opaque to the loop, which only forwards it to the host).
 * An empty array is omitted so the no-audit case stays identical to a bare gate.
 *
 * Calling with zero gates is a programming error (an empty AND would vacuously
 * allow everything, defeating the gate) and throws.
 *
 * @public
 */
export function composeActionGates(...gates: readonly ActionGate[]): ActionGate {
  if (gates.length === 0) {
    throw new Error(
      "composeActionGates requires at least one gate (an empty composition would allow everything, defeating the seam)",
    );
  }
  return {
    async verify(call: ActionGateCall): Promise<ActionGateVerdict> {
      const auditSteps: unknown[] = [];
      const denyReasons: string[] = [];
      const denyKinds = new Set<string>();
      for (const gate of gates) {
        let verdict: ActionGateVerdict;
        try {
          verdict = await gate.verify(call);
        } catch (err) {
          // fail-closed: a throwing sub-gate denies the call, never escapes.
          const reason = err instanceof Error ? err.message : String(err);
          denyReasons.push(`gate error (fail-closed): ${reason}`);
          continue;
        }
        if (verdict.auditStep !== undefined) {
          auditSteps.push(verdict.auditStep);
        }
        if (!verdict.allowed) {
          denyReasons.push(verdict.reason);
          if (verdict.kind !== undefined) denyKinds.add(verdict.kind);
        }
      }
      const allowed = denyReasons.length === 0;
      // A single distinct kind among the denying sub-gates propagates
      // (e.g. every denial this call hit was "posture_denied") ; a mix of
      // kinds, or none declared, leaves `kind` unset rather than guess which
      // one the host should surface — the composed `reason` still lists
      // every denial verbatim.
      const kind = denyKinds.size === 1 ? [...denyKinds][0] : undefined;
      const base: ActionGateVerdict = {
        allowed,
        reason: allowed
          ? "action allowed (all gates accepted)"
          : `action denied (composed): ${denyReasons.join("; ")}`,
        ...(kind !== undefined ? { kind } : {}),
      };
      return auditSteps.length > 0 ? { ...base, auditStep: auditSteps } : base;
    },
  };
}
