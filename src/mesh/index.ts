/**
 * src/mesh/index.ts
 *
 * Public barrel for the mesh.delegate() surface (sprint-585).
 *
 * @deprecated (sprint-877 reconciliation, 2026-07-05) — this whole subsystem
 * is a second, ADR-less delegation lineage with zero callers in this monorepo
 * outside its own tests; the canonical governed lineage is
 * `delegation/delegate.ts` (ADR-ECO-076). See the STATUS note atop
 * `mesh/delegate.ts` for the full finding and why it is documented, not
 * deleted, in this pass (live un-namespaced npm export at v3.3.0; removal is a
 * major-version release decision).
 */

export {
  attenuateScope,
  buildToken,
  parseToken,
  scopeAllows,
  type AttenuatedToken,
  type CapabilityScope,
  type MeshCapabilityScope,
} from "./attenuation.js";

export {
  DefaultMeshDispatcher,
  DeadlineExceededError as MeshDeadlineExceededError,
  MeshDispatchError,
  defaultClassifier,
  type DispatchIntent,
  type DispatchResult,
  type DispatcherConfig,
  type MeshDispatcher,
} from "./dispatcher.js";

export {
  DelegateAttenuationError,
  createMeshDelegate,
  meshDelegate,
  type DelegateChunk,
  type DelegateOptions,
  type DelegateResult,
} from "./delegate.js";

export type { DelegationLink, MeshAgentKind } from "./types.js";
