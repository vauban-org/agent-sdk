/**
 * verify/verifiers/cost-gate.ts
 *
 * costGateLens ; a deterministic "rule"-engine lens enforcing the session cost
 * gate (ADR-ECO-045) as a battery verifier. It is a faithful TypeScript port of
 * governance/policy/opa-policies/cost-gate.rego: the same 8 deny-rules, the same
 * budget caps and forbidden-model table. A parity test replays the rego's own
 * fixtures and asserts an identical allow/deny verdict, so the policy and this
 * port cannot silently drift.
 *
 * Governance-sync note (rewritten 2026-09-01): this gate has now been found
 * disarmed TWICE on a model identifier, by two different mechanisms.
 *
 *   - 2026-07-08, by DIVERGENCE: this mirror still listed the family-4.7 Opus
 *     while the rego had moved on. The copies disagreed.
 *   - 2026-09-01, by STALENESS: mirror, rego and rule prose all agreed on the
 *     family-4.8 Opus identifier, while the Opus actually in service belonged to
 *     family 5. All three copies were consistent, and all three were wrong.
 *
 * The second case is the important one: a single source of truth would NOT have
 * caught it. Consistency between copies is not correctness against the world.
 * Both are now closed by matching on model FAMILY prefixes rather than exact
 * identifiers, so a new model release cannot silently disarm the gate.
 *
 * The parity fixtures remain copies of the rego's own tests; when the rego's
 * family table changes, this table AND tests/verify-cost-gate.test.ts MUST change
 * in the same commit. That rule held in July and did not prevent September,
 * because it guards divergence and says nothing about staleness.
 *
 * @module verify/verifiers/cost-gate
 */

import type { BatteryLens } from "../../compute/battery/types.js";

/**
 * Canonical session tiers.
 * @public
 */
export type Tier = "XS" | "S" | "M" | "L" | "XL";

/**
 * Agent-run declaration ; the gate input (cf schemas/agent-run-declaration.json).
 * @public
 */
export interface AgentRunDeclaration {
  readonly session_id: string;
  readonly started_at?: string;
  readonly intention: string;
  /** Declared tier. Typed `string` (not Tier) so the unknown-tier rule is reachable. */
  readonly tier: string;
  readonly model: string;
  readonly token_budget_max: number;
  readonly max_iterations: number;
  readonly max_iterations_justification?: string;
  readonly approved_by: string;
  readonly rollback_plan?: string;
  readonly extends_session?: string | boolean;
  readonly tools_required?: readonly string[];
}

/**
 * Per-tier token budget caps (cost-gate.rego budget_cap).
 * @public
 */
export const BUDGET_CAP: Record<Tier, number> = {
  XS: 8000,
  S: 20000,
  M: 40000,
  L: 80000,
  XL: 150000,
};

/**
 * Forbidden model FAMILIES per tier (cost-gate.rego forbidden_model_families_per_tier).
 *
 * Matching is by PREFIX, never by exact identifier. On 2026-09-01 this gate was found
 * disarmed for the second time on a model identifier: the table listed the exact id of
 * the family-4 Opus while the Opus in service belonged to family 5, so the XS/S gate
 * refused a retired model and let the live one through.
 *
 * The first time, in July 2026, the failure was a DIVERGENCE between this mirror and
 * the rego. This time all three copies (rule prose, rego, this mirror) were perfectly
 * CONSISTENT with each other and all stale against the world. A single source of truth
 * would not have caught it; what catches it is reasoning by family, which is what
 * `rules/delivery/model-selection.md` already prescribed: "obsolescence is handled by
 * family aliases, not by chasing version numbers".
 *
 * @public
 */
export const FORBIDDEN_MODEL_FAMILIES_PER_TIER: Record<Tier, readonly string[]> = {
  XS: ["claude-opus"],
  S: ["claude-opus"],
  M: [],
  L: [],
  XL: [],
};

/**
 * Forbidden models per tier, as exact identifiers.
 *
 * @deprecated since 2026-09-01, removal no earlier than 2028-09-01 (24-month public-stable
 * window per governance `architecture/contract-stability.md`). It no longer drives the
 * verdict: {@link costGateDeny} matches on {@link FORBIDDEN_MODEL_FAMILIES_PER_TIER} by
 * prefix, because an exact identifier goes stale at every model release and silently
 * disarms the gate. Kept exported so downstream consumers do not break; read it as a
 * historical illustration, never as the live policy.
 *
 * @public
 */
export const FORBIDDEN_MODELS_PER_TIER: Record<Tier, readonly string[]> = {
  XS: ["claude-opus-4-8"],
  S: ["claude-opus-4-8"],
  M: [],
  L: [],
  XL: [],
};

/**
 * Governing decision record for this gate ; pass as the battery's adrEco.
 * @public
 */
export const COST_GATE_ADR = "ADR-ECO-045";

const ALLOWED_SELF_TIERS: ReadonlySet<string> = new Set(["XS", "S"]);
const REQUIRES_ROLLBACK: ReadonlySet<string> = new Set(["M", "L", "XL"]);

/**
 * Evaluate the 8 cost-gate deny-rules. Returns the list of violation messages;
 * an empty list means allow. Pure and deterministic, byte-for-byte faithful to
 * cost-gate.rego's verdict.
 * @public
 */
export function costGateDeny(d: AgentRunDeclaration): string[] {
  const deny: string[] = [];
  const tier = d.tier as Tier;
  const cap: number | undefined = BUDGET_CAP[tier];

  // DENY-8 : unknown tier (defense-in-depth)
  if (cap === undefined) {
    deny.push(`unknown tier ${d.tier} (allowed: XS, S, M, L, XL)`);
  }

  // DENY-1 : forbidden model FAMILY for tier. Prefix match, so it covers every
  // present and future Opus without an edit ; an exact identifier disarmed this
  // gate twice (audit 2026-07-08 by divergence, 2026-09-01 by staleness).
  const forbiddenFamilies = FORBIDDEN_MODEL_FAMILIES_PER_TIER[tier];
  const family = forbiddenFamilies?.find((f) => d.model.startsWith(f));
  if (family !== undefined) {
    deny.push(`model ${d.model} forbidden on tier ${d.tier} (family ${family} ; cost-gate R7.2)`);
  }

  // DENY-2 : token_budget_max exceeds tier cap (known tiers only)
  if (cap !== undefined && d.token_budget_max > cap) {
    deny.push(
      `token_budget_max ${d.token_budget_max} exceeds tier ${d.tier} cap ${cap} (cost-gate R7.3)`,
    );
  }

  // DENY-3 : max_iterations > 5 without justification
  if (d.max_iterations > 5 && !d.max_iterations_justification) {
    deny.push("max_iterations > 5 requires max_iterations_justification (cost-gate R7.4)");
  }

  // DENY-4 : self-approval only for XS/S
  if (d.approved_by === "self" && !ALLOWED_SELF_TIERS.has(d.tier)) {
    deny.push(`approved_by=self only allowed for tier XS or S; got ${d.tier}`);
  }

  // DENY-5 : rollback_plan required for M/L/XL
  if (REQUIRES_ROLLBACK.has(d.tier) && !d.rollback_plan) {
    deny.push(`tier ${d.tier} requires rollback_plan`);
  }

  // DENY-6 : worker (extends_session set) must not carry the Agent tool (R-4)
  if (d.extends_session && (d.tools_required ?? []).includes("Agent")) {
    deny.push("worker (extends_session set) cannot include Agent tool (R-4 ADR-ECO-045)");
  }

  // DENY-7 : intention length out of [10, 280]
  const len = d.intention.length;
  if (len < 10) deny.push(`intention too short (${len} chars, min 10)`);
  if (len > 280) deny.push(`intention too long (${len} chars, max 280)`);

  return deny;
}

/**
 * True when the declaration passes every cost-gate rule (deny set empty).
 * @public
 */
export function costGateAllow(d: AgentRunDeclaration): boolean {
  return costGateDeny(d).length === 0;
}

/**
 * Build the cost-gate {@link BatteryLens}: a hard affirm rule lens scoring 1 when
 * the declaration is allowed and 0 (with the joined violations as rationale) when
 * any rule denies. Pair it with `adrEco: COST_GATE_ADR` on the battery call.
 * @public
 */
export function costGateLens(opts: { name?: string } = {}): BatteryLens<AgentRunDeclaration> {
  const name = opts.name ?? "cost-gate";
  return {
    verifier: {
      name,
      evaluate: (d: AgentRunDeclaration) => {
        const denies = costGateDeny(d);
        return denies.length === 0
          ? { score: 1, rationale: "cost-gate: allow (0 violations)" }
          : { score: 0, rationale: `cost-gate: deny ; ${denies.join("; ")}` };
      },
    },
    polarity: "affirm",
    criticality: "hard",
    signature: { engine: "rule" },
  };
}
