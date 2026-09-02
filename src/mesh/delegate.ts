/**
 * src/mesh/delegate.ts
 *
 * `mesh.delegate()` — intent-based dispatch to the best available agent.
 *
 * @deprecated (sprint-877 reconciliation, 2026-07-05) — see STATUS below.
 * This is a DIFFERENT primitive from `delegation/delegate.ts` (the canonical
 * ADR-ECO-076 governed sub-agent delegation lineage): this one classifies a
 * free-text "need" and DISPATCHES it to a `MeshDispatcher`-selected agent kind
 * (ooda / llm-router / mcp-tool / plugin / fallback); it does not plan or spawn
 * a governed child agent loop. The two independently re-implement the same
 * child-scope-⊆-parent-scope attenuation invariant (this module's
 * `attenuateScope`/`meshGovernanceLens` vs. `delegation/delegate.ts`'s
 * `attenuate`/`attenuationLens`) with no shared code, which is exactly the
 * silent-divergence risk `rules/core/craft-standards.md` and
 * `rules/architecture/governed-primitives.md` warn against: a fix to one
 * enforcement path does not propagate to the other.
 *
 * STATUS (verified 2026-07-05, sprint-877): a repo-wide grep for
 * `mesh/delegate`, `meshDelegate`, `createMeshDelegate`, `DefaultMeshDispatcher`
 * and `MeshDispatcher` across every package, app, and test in this monorepo
 * turns up ZERO callers outside `src/mesh/**` and its own test files
 * (`tests/mesh-delegate.test.ts`, `tests/mesh-dispatcher.test.ts`,
 * `tests/mesh-attenuation.test.ts`). No ADR ever governed this lineage (the
 * `MESH_DELEGATE_ADR` binding below borrows ADR-ECO-076 as "closest normative
 * fit", it is not that ADR's actual scope).
 *
 * NOT deleted in this pass because it remains a live, un-namespaced export of
 * `@vauban-org/agent-sdk` at v3.3.0 (published npm, `access: restricted` per
 * `.changeset/config.json` but still a real consumer-facing surface with no
 * subpath isolation) — the v1.x-freeze marker below was never revisited after
 * the freeze happened, so "may change before v1.x" is stale. `.github/
 * workflows/api-contract.yml` mechanically treats any export removal as
 * breaking and requires a major version bump + changeset; that is a release
 * decision for whoever owns the agent-sdk release train, not something a
 * reconciliation task should force through silently. If a deprecation window
 * confirms zero external consumers, remove this module + `mesh/dispatcher.ts`
 * + `mesh/attenuation.ts` + `mesh/types.ts` + their re-exports in one major
 * bump, citing this note.
 *
 * Replaces manual `withCompute()` boilerplate with a one-liner:
 *
 *     const r = await meshDelegate({ need: "summarize the spec" }, dispatcher);
 *
 * Responsibilities:
 *   1. Classify need → AgentKind (via dispatcher.classify or injected hint).
 *   2. Apply capability attenuation if a parent token is present.
 *   3. Govern the proposed call through a VerifierBattery gate (ADR-ECO-076
 *      borrowed as closest fit) before dispatch — fail-closed, mirrors
 *      `delegation/delegate.ts` in STRUCTURE only, not in a shared ADR.
 *   4. Forward to dispatcher with budget/deadline guards.
 *   5. Build a delegation chain link for audit.
 *
 * Streaming (`onChunk`) is a best-effort surface — the dispatcher must opt-in
 * by exposing a `dispatchStream` (not part of base contract). When unavailable,
 * the final result is delivered as a single chunk after completion.
 */

import { batteryActionGate } from "../compute/battery/action-gate.js";
import type { BatteryLens } from "../compute/battery/types.js";
import { NON_DELEGABLE_TOOLS, baseToolName } from "../delegation/delegate.js";
import { RealClock } from "../replay/clock.js";
import type { ClockPort } from "../replay/clock.js";
import {
  type AttenuatedToken,
  type MeshCapabilityScope,
  attenuateScope,
  buildToken,
  scopeAllows,
} from "./attenuation.js";
import {
  DefaultMeshDispatcher,
  type DispatchIntent,
  type MeshDispatcher,
} from "./dispatcher.js";
import type { DelegationLink, MeshAgentKind } from "./types.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** @public */
export interface DelegateChunk {
  readonly text: string;
  readonly done: boolean;
  readonly agentKind?: MeshAgentKind;
}

/** @public */
export interface DelegateOptions {
  /** Natural language description of the need. */
  readonly need: string;
  /** Optional structured or free-form context. Serialized to JSON if object. */
  readonly context?: string | Record<string, unknown>;
  /** Caller-requested capabilities (subject to attenuation if parentToken present). */
  readonly capabilities?: ReadonlyArray<string>;
  /** Wall-clock budget in ms. Default 30 000. */
  readonly deadline_ms?: number;
  /** Cost cap in EUR. Default 0.01. */
  readonly max_cost_eur?: number;
  /** Parent token — when present, child scope = parent ∩ requested capabilities. */
  readonly parentToken?: AttenuatedToken;
  /** Optional streaming callback. */
  readonly onChunk?: (chunk: DelegateChunk) => void;
  /** Optional pre-resolved kind — skips classifier. */
  readonly kind?: MeshAgentKind;
  /** Stable child agent identifier (for delegation chain audit). Default: random. */
  readonly childId?: string;
  /** MCP tool name (only when kind === "mcp-tool"). */
  readonly toolName?: string;
  /** MCP tool args (only when kind === "mcp-tool"). */
  readonly toolArgs?: unknown;
  /**
   * Clock for the pre-dispatch governance audit step (ADR-ECO-076). Defaults
   * to RealClock. Inject a RecordedClock for deterministic replay/tests.
   */
  readonly clock?: ClockPort;
}

/** @public */
export interface DelegateResult<T = string> {
  readonly output: T;
  readonly agentKind: MeshAgentKind;
  readonly delegationChain: ReadonlyArray<DelegationLink>;
  readonly costEur: number;
  readonly durationMs: number;
  readonly truncated: boolean;
  /** Token issued to the child — empty when no parentToken given. */
  readonly childToken?: AttenuatedToken;
  /**
   * The governed pre-dispatch audit step (ADR-ECO-076 battery gate). Opaque
   * to the caller; fold into the host's own trace rootHash, exactly like
   * `delegate()`'s `DelegationPlan.auditStep`.
   */
  readonly auditStep?: unknown;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_COST_EUR = 0.01;
const SELF_ID = "mesh:caller";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringifyContext(
  ctx?: string | Record<string, unknown>
): string | undefined {
  if (ctx === undefined) return undefined;
  if (typeof ctx === "string") return ctx;
  try {
    return JSON.stringify(ctx);
  } catch {
    return String(ctx);
  }
}

function isDispatcherWithClassify(
  d: MeshDispatcher
): d is MeshDispatcher & { classify(need: string): MeshAgentKind } {
  return typeof (d as { classify?: unknown }).classify === "function";
}

function generateChildId(): string {
  // Tiny non-cryptographic id — child-id is for audit, not auth.
  // Production: replace with ULID/UUID from caller env.
  return `mesh-child-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6
  ).toString(36)}`;
}

/**
 * Compute child scope from parent token + caller-requested capabilities.
 * Returns the issued child token (parented to caller's parentId) and the
 * effective MeshCapabilityScope (post-intersection).
 */
function issueChildToken(
  parentToken: AttenuatedToken,
  requestedCapabilities: ReadonlyArray<string> | undefined,
  requestedBudgetEur: number,
  childId: string
): { token: AttenuatedToken; scope: MeshCapabilityScope } {
  const parentScope: MeshCapabilityScope = {
    actions: parentToken.scope,
    budgetEur: parentToken.budgetEur,
    expiresAt: parentToken.expiresAt
      ? new Date(parentToken.expiresAt)
      : undefined,
  };
  const requestedScope: MeshCapabilityScope = {
    actions: requestedCapabilities ?? parentToken.scope,
    budgetEur: requestedBudgetEur,
  };
  const childScope = attenuateScope(parentScope, requestedScope);
  const token = buildToken(childScope, childId);
  return { token, scope: childScope };
}

// ─── Governance (ADR-ECO-076 pre-dispatch battery gate) ───────────────────────

/**
 * Governing decision record for the mesh pre-dispatch battery gate. No
 * mesh-specific ADR exists (grep of `src/mesh/` confirms zero prior ADR-ECO
 * references); ADR-ECO-076 (governed delegation primitive) is the closest
 * normative fit — it established the strict-subset-of-parent + fail-closed
 * VerifierBattery invariant that `delegate()` enforces, and this gate closes
 * the same gap for `meshDelegate()`.
 * @public
 */
export const MESH_DELEGATE_ADR = "ADR-ECO-076";

/**
 * The candidate the pre-dispatch battery lens scores. `subsetViolations` and
 * `budgetViolation` should ALWAYS be empty/false by construction (attenuation
 * already guarantees child ⊆ parent above) — this is a defense-in-depth
 * assertion of that already-enforced invariant, governed through the battery
 * so it gets an audit step and ADR traceability, not a re-derivation of new
 * logic. `recursionTool` is the one genuinely new check: a mesh-dispatched
 * mcp-tool call may never target a non-delegable recursion primitive.
 */
interface MeshGovernanceCandidate {
  readonly effectiveScope: readonly string[];
  readonly subsetViolations: readonly string[];
  readonly budgetViolation: boolean;
  readonly recursionTool: string | undefined;
}

/**
 * The deterministic non-llm-judge anchor (engine "rule", hard affirm) for the
 * mesh pre-dispatch gate: a candidate is accepted iff its effective scope is
 * a genuine subset of the parent grant, its budget does not exceed the parent
 * grant, and it does not target a non-delegable recursion primitive.
 * @public
 */
const meshGovernanceLens: BatteryLens<MeshGovernanceCandidate> = {
  verifier: {
    name: "mesh-delegate-governance",
    evaluate: (c) => {
      if (c.recursionTool !== undefined) {
        return {
          score: 0,
          rationale: `recursion: mcp-tool "${c.recursionTool}" is a non-delegable primitive`,
        };
      }
      if (c.subsetViolations.length > 0) {
        return {
          score: 0,
          rationale: `escalation: effective scope exceeds parent grant: ${c.subsetViolations.join(
            ", "
          )}`,
        };
      }
      if (c.budgetViolation) {
        return {
          score: 0,
          rationale: "escalation: effective budget exceeds parent grant",
        };
      }
      return {
        score: 1,
        rationale: `governance valid: ${c.effectiveScope.length} capability(ies) within parent grant, no recursion`,
      };
    },
  },
  polarity: "affirm",
  criticality: "hard",
  signature: { engine: "rule" },
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/** @public */
export class DelegateAttenuationError extends Error {
  override readonly name = "DelegateAttenuationError";
}

/**
 * Thrown when the ADR-ECO-076 pre-dispatch battery gate denies fail-closed:
 * the effective scope/budget escapes the parent grant (should be impossible
 * by construction; defense-in-depth), or the call targets a non-delegable
 * recursion primitive.
 * @public
 */
export class MeshGovernanceDeniedError extends Error {
  override readonly name = "MeshGovernanceDeniedError";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Delegate a need to the best available agent.
 *
 * Routing priority (when `kind` not pre-set):
 *  1. Dispatcher's `classify(need)` hook if present.
 *  2. Heuristic — see `defaultClassifier`.
 *
 * Capability attenuation:
 *  - If `parentToken` is provided, child scope = parent ∩ requested.
 *  - Empty intersection raises {@link DelegateAttenuationError}.
 *
 * Budget guards:
 *  - When `parentToken.budgetEur < max_cost_eur`, the effective max is parent's.
 *  - Negative budget or deadline → RangeError.
 * @deprecated Use `delegate()` from `delegation/delegate.ts` (ADR-ECO-076) to
 * spawn a governed sub-agent. See the module-header STATUS note: zero callers
 * in this monorepo as of 2026-07-05; kept only pending an external-consumer
 * deprecation window (removal is a major-version decision, not this task's).
 * @public
 */
export async function meshDelegate<T = string>(
  options: DelegateOptions,
  dispatcher: MeshDispatcher
): Promise<DelegateResult<T>> {
  if (
    !options ||
    typeof options.need !== "string" ||
    options.need.length === 0
  ) {
    throw new TypeError(
      "meshDelegate: `need` is required and must be a non-empty string"
    );
  }
  if (!dispatcher || typeof dispatcher.dispatch !== "function") {
    throw new TypeError(
      "meshDelegate: `dispatcher` must implement MeshDispatcher"
    );
  }

  const deadlineMs = options.deadline_ms ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError(
      `meshDelegate: deadline_ms must be > 0, got ${deadlineMs}`
    );
  }
  let maxCostEur = options.max_cost_eur ?? DEFAULT_MAX_COST_EUR;
  if (!Number.isFinite(maxCostEur) || maxCostEur < 0) {
    throw new RangeError(
      `meshDelegate: max_cost_eur must be ≥ 0, got ${maxCostEur}`
    );
  }

  // ── 1. Classify ──────────────────────────────────────────────────────────
  const kind: MeshAgentKind =
    options.kind ??
    (isDispatcherWithClassify(dispatcher)
      ? dispatcher.classify(options.need)
      : "llm-router");

  // ── 2. Attenuation (if parent token given) ───────────────────────────────
  const childId = options.childId ?? generateChildId();
  let childToken: AttenuatedToken | undefined;
  let effectiveScope: ReadonlyArray<string> | undefined;
  if (options.parentToken) {
    const issued = issueChildToken(
      options.parentToken,
      options.capabilities,
      maxCostEur,
      childId
    );
    if (
      issued.scope.actions.length === 0 &&
      (options.capabilities?.length ?? 0) > 0
    ) {
      throw new DelegateAttenuationError(
        "meshDelegate: requested capabilities are not granted by parent scope"
      );
    }
    childToken = issued.token;
    effectiveScope = issued.scope.actions;
    // Enforce parent budget cap.
    maxCostEur = Math.min(maxCostEur, issued.scope.budgetEur);
  } else if (options.capabilities) {
    effectiveScope = options.capabilities;
  }

  // ── 3. Governed pre-dispatch gate (ADR-ECO-076; VerifierBattery, fail-closed) ──
  const parentScope = options.parentToken?.scope;
  const subsetViolations = parentScope
    ? (effectiveScope ?? []).filter(
        (action) =>
          !scopeAllows(
            {
              actions: parentScope,
              budgetEur: options.parentToken?.budgetEur ?? 0,
            },
            action
          )
      )
    : [];
  const budgetViolation =
    options.parentToken !== undefined &&
    maxCostEur > options.parentToken.budgetEur;
  const recursionTool =
    kind === "mcp-tool" &&
    options.toolName !== undefined &&
    NON_DELEGABLE_TOOLS.has(baseToolName(options.toolName))
      ? options.toolName
      : undefined;
  const governanceCandidate: MeshGovernanceCandidate = {
    effectiveScope: effectiveScope ?? [],
    subsetViolations,
    budgetViolation,
    recursionTool,
  };
  const governanceGate = batteryActionGate<MeshGovernanceCandidate>({
    lenses: [meshGovernanceLens],
    adrEco: MESH_DELEGATE_ADR,
    clock: options.clock ?? new RealClock(),
    runId: childId,
    project: () => governanceCandidate,
  });
  const governanceVerdict = await governanceGate.verify({
    toolName: options.toolName ?? kind,
    args: { need: options.need, capabilities: effectiveScope ?? [] },
    budgetUsed: 0,
  });
  if (!governanceVerdict.allowed) {
    throw new MeshGovernanceDeniedError(
      `meshDelegate: ${governanceVerdict.reason}`
    );
  }

  // ── 4. Dispatch ──────────────────────────────────────────────────────────
  const intent: DispatchIntent = {
    kind,
    need: options.need,
    context: stringifyContext(options.context),
    deadline_ms: deadlineMs,
    max_cost_eur: maxCostEur,
    toolName: options.toolName,
    toolArgs: options.toolArgs,
  };

  const dispatched = await dispatcher.dispatch(intent);

  // ── 5. Audit chain ───────────────────────────────────────────────────────
  const parentIdForLink = options.parentToken?.parentId ?? SELF_ID;
  const link: DelegationLink = {
    from: parentIdForLink,
    to: childId,
    scope: effectiveScope ?? [],
    budget: maxCostEur,
  };

  // ── 6. Stream (best-effort, single-shot when streaming not supported) ────
  if (options.onChunk) {
    options.onChunk({ text: dispatched.output, done: true, agentKind: kind });
  }

  const result: DelegateResult<T> = {
    output: dispatched.output as unknown as T,
    agentKind: kind,
    delegationChain: [link],
    costEur: dispatched.costEur,
    durationMs: dispatched.durationMs,
    truncated: dispatched.truncated,
    childToken,
    auditStep: governanceVerdict.auditStep,
  };
  return result;
}

/**
 * Factory variant — binds a dispatcher so callers can call `delegate(opts)`
 * without re-passing the dispatcher every time.
 *
 * Useful for DI in long-lived services.
 * @deprecated See `meshDelegate` deprecation note above.
 * @public
 */
export function createMeshDelegate(
  dispatcher: MeshDispatcher
): <T = string>(options: DelegateOptions) => Promise<DelegateResult<T>> {
  return <T = string>(options: DelegateOptions) =>
    meshDelegate<T>(options, dispatcher);
}

/**
 * Re-export DefaultMeshDispatcher as a convenience so callers can do:
 *
 *     import { meshDelegate, DefaultMeshDispatcher } from "@vauban-org/agent-sdk";
 */
export { DefaultMeshDispatcher };
