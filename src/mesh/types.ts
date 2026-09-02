/**
 * src/mesh/types.ts
 *
 * Shared types for mesh.delegate() and dispatcher.
 *
 * @deprecated Support module for `mesh/delegate.ts`, which has zero callers
 * in this monorepo as of 2026-07-05 (sprint-877 reconciliation). See the
 * STATUS note atop `mesh/delegate.ts` before adding a new dependency on this.
 *
 * Renamed from "AgentKind" to "MeshAgentKind" to avoid clash with
 * `registry/agent-capability.ts::AgentKind` (which uses uppercase enum values
 * ARCHITECT/BUILDER/...).
 */

/**
 * Kind of executor selected by the dispatcher.
 *  - `"ooda"`          : long-running Observe→Orient→Decide→Act loop
 *  - `"llm-router"`    : single LLM call (single-shot or BoN-MAV)
 *  - `"mcp-tool"`      : direct MCP tool invocation
 *  - `"plugin"`        : in-process plugin executor
 *  - `"fallback"`      : last-resort echo / static handler
 * @public
 */
export type MeshAgentKind = "ooda" | "llm-router" | "mcp-tool" | "plugin" | "fallback";

/**
 * One step of the delegation chain (audit trail for capability narrowing).
 * @public
 */
export interface DelegationLink {
  /** Parent / delegator agent identifier. */
  readonly from: string;
  /** Child / delegatee agent identifier. */
  readonly to: string;
  /** Scope handed down (subset of parent's scope). */
  readonly scope: ReadonlyArray<string>;
  /** Budget handed down in EUR. */
  readonly budget: number;
}
