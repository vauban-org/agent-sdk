/**
 * scheduler.ts — result-driven DAG scheduler (SOTA orchestration engine, Cap 2).
 *
 * Replaces the flat parallel batch with a dependency graph executed with
 * MAXIMAL parallelism: every node whose `dependsOn` are all `done` runs
 * concurrently (Kahn's algorithm over the ready-frontier). Independent nodes
 * run in parallel; dependent nodes wait for their upstream outputs.
 *
 * PURE: no fs, no network, no Date.now(). All time comes from `input.clock`.
 * Types are imported ONLY from ./contracts.js and existing agent-sdk modules
 * (sha256, canonicalize). The engine depends on the injected NodeExecutor /
 * Verifier ports — never on a concrete executor or on packages/cli (preste).
 *
 * ADR-ECO-083 four-properties (replay-safe rootHash):
 *   (1) Determinism      pure function of inputs + injected ClockPort.
 *   (2) Audit anchor      `rootHash` = sha256(canonical(governance payload)).
 *   (3) ADR-traceability  `adrEco` mandatory; throws when absent.
 *   (4) Replay            `rootHash` commits ONLY to PRE-EXECUTION governance
 *                         fields (adrEco + per-node {id, dependsOn}); it NEVER
 *                         includes runtime status/outputs, so the same inputs
 *                         yield a byte-identical hash regardless of execution.
 *
 * See docs/superpowers/specs/2026-06-05-sota-orchestration-engine-design.md.
 *
 * @module orchestration/dag/scheduler
 */

import { sha256 } from "../../proof/sha256.js";
import { canonicalize } from "../../trace/canonical.js";
import type {
  DagNodeSpec,
  DagRunInput,
  DagRunManifest,
  NodeInputs,
  NodeManifestEntry,
  NodeOutcome,
  NodeStatus,
  Verifier,
  VerifierVerdict,
  WorkflowProgressEvent,
} from "./contracts.js";

// ─── Errors ────────────────────────────────────────────────────────────────

/** Thrown for malformed DAGs (cycle, duplicate id, missing dep, etc.). */
export class DagSchedulerError extends Error {
  constructor(reason: string) {
    super(`DagSchedulerError: ${reason}`);
    this.name = "DagSchedulerError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Internal per-node runtime record ────────────────────────────────────────

interface NodeRecord<TOutput> {
  spec: DagNodeSpec;
  dependsOn: readonly string[];
  status: NodeStatus | "pending";
  reason: string | null;
  output: TOutput | null;
  attempts: number;
  /**
   * Cap 4 — number of automatic own-timeout retries ALREADY consumed by this
   * node. A node is retried (reset to `pending`) only while this is strictly
   * below its resolved retry bound. Runtime-only: never folded into rootHash.
   */
  retriesUsed: number;
  /**
   * Cap 4 — true once this node's terminal failure has been offered to the
   * re-planner (whether or not a replan was accepted), so a persistently-failed
   * node is offered at most once and does not loop. Runtime-only.
   */
  replanOffered: boolean;
}

// ─── Cap 4: stable own-timeout marker ─────────────────────────────────────────

/**
 * Machine-detectable prefix for a deferral caused by the SCHEDULER's own
 * per-node timeout race (callExecutor below). Cap 4 retries ONLY this kind of
 * deferral; upstream-not-done, runIf-skip, cancel, and executor-returned
 * deferrals (which may themselves be a cancel) are NEVER retried. Keeping it a
 * stable internal constant makes the retry decision deterministic rather than
 * relying on free-text reason matching.
 */
const OWN_TIMEOUT_REASON_PREFIX = "timeout:";

/** True iff `reason` marks a scheduler-armed own-timeout deferral. */
function isOwnTimeoutDeferral(
  status: NodeStatus | "pending",
  reason: string | null,
): boolean {
  return (
    status === "deferred" &&
    typeof reason === "string" &&
    reason.startsWith(OWN_TIMEOUT_REASON_PREFIX)
  );
}

/** Resolve a node's own-timeout retry bound (per-node overrides global). */
function resolveRetryBound<TOutput>(
  spec: DagNodeSpec,
  input: DagRunInput<TOutput>,
): number {
  const raw = spec.maxTimeoutRetries ?? input.defaultMaxTimeoutRetries ?? 0;
  return raw > 0 ? Math.floor(raw) : 0;
}

// ─── Progress emit (Cap 5) ───────────────────────────────────────────────────

/**
 * Fail-soft progress emit. A throwing sink must NEVER break the DAG run, so the
 * `emit` call is wrapped in a swallowing try/catch. When `input.progress` is
 * undefined every call is a cheap no-op (additive invariant: zero behaviour
 * change vs a run without progress). Timestamps come from `input.clock.now()`.
 */
function emitProgress<TOutput>(
  input: DagRunInput<TOutput>,
  event: WorkflowProgressEvent<TOutput>,
): void {
  if (!input.progress) return;
  try {
    input.progress.emit(event);
  } catch {
    // Swallow: progress is observational; it cannot affect the run.
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Execute a DAG of delegated work with maximal parallelism and a replay-safe
 * governance rootHash.
 *
 * Semantics:
 *  - A node runs once ALL its `dependsOn` are `done`.
 *  - A node whose ANY dependency ends `failed` or `deferred` is itself
 *    `deferred` (reason: "upstream <id> not done") — partial-failure tolerant:
 *    independent branches still complete.
 *  - `runIf(inputs)` false → node `deferred`, reason "skipped". Its dependents
 *    see it as not-done and therefore become `deferred` too (skip propagates).
 *  - `mapOver: <depId>` → the named upstream output MUST be an array; the node
 *    fans into one executor call per element (Send-API style) and the node's
 *    output is the array of child outputs.
 *  - `samples > 1` → best-of-N: run `samples` attempts, rank via `input.verifier`
 *    (required), keep the accepted-best; `accepted=null` → node `failed`
 *    (fail-closed). A run with any node `samples>1` and no verifier throws.
 *  - `workflowStatus` = DONE if ≥1 node `done`, else FAILED.
 */
export async function runDag<TOutput = unknown>(
  input: DagRunInput<TOutput>,
): Promise<DagRunManifest<TOutput>> {
  // ── ADR-traceability (cargo-cult guard, ADR-ECO-068/083) ──
  if (!input.adrEco || input.adrEco.trim() === "") {
    throw new DagSchedulerError(
      "adrEco is mandatory (cargo-cult guard, ADR-ECO-083). " +
        "Pass the governing ADR identifier on the run.",
    );
  }
  if (!input.runId || input.runId.trim() === "") {
    throw new DagSchedulerError("runId is mandatory");
  }

  const nodes = input.nodes;
  if (nodes.length === 0) {
    throw new DagSchedulerError("DAG must have at least one node");
  }

  // ── Structural validation (before any execution) ──
  const records = buildRecords<TOutput>(nodes);
  assertNoMissingDeps(records);
  assertNoMapOverMisuse(records);
  assertAcyclic(records); // throws DagSchedulerError on a cycle

  // ── best-of-N precondition ──
  const usesSampling = nodes.some((n) => (n.samples ?? 1) > 1);
  if (usesSampling && !input.verifier) {
    throw new DagSchedulerError(
      "a node sets samples > 1 but no verifier was provided " +
        "(best-of-N requires a Verifier, fail-closed per ADR-ECO-068)",
    );
  }

  // ── Pre-execution governance rootHash (replay-safe) ──
  // Commits ONLY to adrEco + a stable per-node {id, dependsOn} fingerprint.
  // No runtime status/output: same inputs => byte-identical hash.
  const rootHash = await computeRootHash(input.adrEco, records);

  // ── Cap 5: workflow_started (once, before any node runs) ──
  emitProgress(input, {
    type: "workflow_started",
    runId: input.runId,
    nodeCount: nodes.length,
    at: input.clock.now(),
  });

  // ── Topological execution with maximal parallelism ──
  await execute<TOutput>(records, input);

  // ── Build manifest ──
  const manifestNodes: Array<NodeManifestEntry<TOutput>> = records.map((r) => ({
    id: r.spec.id,
    status: r.status === "pending" ? "deferred" : r.status,
    reason: r.status === "pending" ? "not scheduled" : r.reason,
    output: r.output,
    dependsOn: r.dependsOn,
    attempts: r.attempts,
  }));

  const summary = {
    total: manifestNodes.length,
    done: manifestNodes.filter((n) => n.status === "done").length,
    deferred: manifestNodes.filter((n) => n.status === "deferred").length,
    failed: manifestNodes.filter((n) => n.status === "failed").length,
  };

  const workflowStatus: "DONE" | "FAILED" =
    summary.done >= 1 ? "DONE" : "FAILED";

  // ── Cap 5: workflow_settled (once, after execution) ──
  // status = CANCELLED when the top-level signal aborted; else the manifest
  // status. The terminal manifest keeps its DONE/FAILED contract (cancelled
  // nodes appear as deferred reason "cancelled") — the CANCELLED signal is a
  // progress-stream concern only, not a new manifest workflowStatus value.
  emitProgress(input, {
    type: "workflow_settled",
    runId: input.runId,
    status: input.signal?.aborted ? "CANCELLED" : workflowStatus,
    total: summary.total,
    done: summary.done,
    deferred: summary.deferred,
    failed: summary.failed,
    at: input.clock.now(),
  });

  return {
    workflowStatus,
    summary,
    nodes: manifestNodes,
    rootHash,
  };
}

// ─── Graph construction + validation ─────────────────────────────────────────

function buildRecords<TOutput>(
  nodes: readonly DagNodeSpec[],
): Array<NodeRecord<TOutput>> {
  const seen = new Set<string>();
  return nodes.map((spec) => {
    if (!spec.id || spec.id.trim() === "") {
      throw new DagSchedulerError("every node must have a non-empty id");
    }
    if (seen.has(spec.id)) {
      throw new DagSchedulerError(`duplicate node id: ${spec.id}`);
    }
    seen.add(spec.id);
    return {
      spec,
      dependsOn: spec.dependsOn ?? [],
      status: "pending" as const,
      reason: null,
      output: null,
      attempts: 0,
      retriesUsed: 0,
      replanOffered: false,
    };
  });
}

function assertNoMissingDeps<TOutput>(
  records: Array<NodeRecord<TOutput>>,
): void {
  const ids = new Set(records.map((r) => r.spec.id));
  for (const r of records) {
    for (const dep of r.dependsOn) {
      if (!ids.has(dep)) {
        throw new DagSchedulerError(
          `node '${r.spec.id}' depends on unknown node '${dep}'`,
        );
      }
      if (dep === r.spec.id) {
        throw new DagSchedulerError(`node '${r.spec.id}' depends on itself`);
      }
    }
  }
}

function assertNoMapOverMisuse<TOutput>(
  records: Array<NodeRecord<TOutput>>,
): void {
  for (const r of records) {
    const mapOver = r.spec.mapOver;
    if (mapOver === undefined) continue;
    if (!r.dependsOn.includes(mapOver)) {
      throw new DagSchedulerError(
        `node '${r.spec.id}' maps over '${mapOver}' but does not depend on it`,
      );
    }
  }
}

/**
 * Cycle detection via Kahn's algorithm: if a topological sort cannot place
 * every node, the remaining nodes form a cycle. Thrown BEFORE any execution.
 */
function assertAcyclic<TOutput>(records: Array<NodeRecord<TOutput>>): void {
  const byId = new Map(records.map((r) => [r.spec.id, r]));
  const indegree = new Map<string, number>();
  for (const r of records) indegree.set(r.spec.id, r.dependsOn.length);

  // dependents[x] = nodes that depend on x
  const dependents = new Map<string, string[]>();
  for (const r of records) {
    for (const dep of r.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(r.spec.id);
      dependents.set(dep, list);
    }
  }

  const queue = records
    .filter((r) => (indegree.get(r.spec.id) ?? 0) === 0)
    .map((r) => r.spec.id);
  let placed = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    placed += 1;
    for (const child of dependents.get(id) ?? []) {
      const d = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }

  if (placed !== records.length) {
    const inCycle = records
      .filter((r) => (indegree.get(r.spec.id) ?? 0) > 0)
      .map((r) => r.spec.id)
      .sort();
    void byId;
    throw new DagSchedulerError(
      `cycle detected among nodes: ${inCycle.join(", ")}`,
    );
  }
}

// ─── Execution (ready-frontier, maximal parallelism) ─────────────────────────

async function execute<TOutput>(
  records: Array<NodeRecord<TOutput>>,
  input: DagRunInput<TOutput>,
): Promise<void> {
  const byId = new Map(records.map((r) => [r.spec.id, r]));
  const maxConcurrency =
    input.maxConcurrency && input.maxConcurrency > 0
      ? input.maxConcurrency
      : Infinity;

  let running = 0;
  const inFlight = new Set<Promise<void>>();

  // ── Cap 4: global replan budget (shared across the whole run) ──
  let replanBudget =
    input.replanner && input.maxReplans && input.maxReplans > 0
      ? Math.floor(input.maxReplans)
      : 0;

  // Loop while any node is still pending OR a terminally-failed node is still
  // eligible for re-planning (Cap 4): a single failed node with no pending peers
  // must still get its replan chance before the run settles.
  const hasReplanWork = (): boolean =>
    !!input.replanner &&
    replanBudget > 0 &&
    !input.signal?.aborted &&
    records.some((r) => r.status === "failed" && !r.replanOffered);
  while (records.some((r) => r.status === "pending") || hasReplanWork()) {
    // ── Cap 5: mid-flight cancel ──
    // If the top-level signal aborted, stop launching NEW pending nodes: mark
    // every still-pending node `deferred` reason "cancelled" and let in-flight
    // nodes settle (they observe the combined per-node signal and may abort
    // early). The next loop iteration sees no pending nodes and drains.
    if (input.signal?.aborted) {
      for (const r of records) {
        if (r.status === "pending") {
          r.status = "deferred";
          r.reason = "cancelled";
          emitProgress(input, {
            type: "node_deferred",
            runId: input.runId,
            nodeId: r.spec.id,
            reason: "cancelled",
            at: input.clock.now(),
          });
        }
      }
      if (inFlight.size > 0) await Promise.allSettled(inFlight);
      break;
    }

    // ── Cap 4: adaptive re-planning ──
    // BEFORE the blocking fixpoint, offer any newly terminally-failed node to
    // the re-planner while budget remains and nothing is in flight that could
    // still change the graph (process one failure at a time, deterministically).
    // Running this before the fixpoint means a successfully-replanned node is
    // reset to `pending` (reused id) so its dependents are NOT prematurely
    // deferred. Only ONE replan is processed per iteration, then we re-loop.
    if (input.replanner && replanBudget > 0) {
      const failedToReplan = records.find(
        (r) => r.status === "failed" && !r.replanOffered,
      );
      if (failedToReplan) {
        failedToReplan.replanOffered = true; // offered at most once
        const inputsForReplan: Record<string, unknown> = {};
        for (const depId of failedToReplan.dependsOn) {
          inputsForReplan[depId] = byId.get(depId)?.output ?? null;
        }
        const failedEntry: NodeManifestEntry<TOutput> = {
          id: failedToReplan.spec.id,
          status: "failed",
          reason: failedToReplan.reason,
          output: failedToReplan.output,
          dependsOn: failedToReplan.dependsOn,
          attempts: failedToReplan.attempts,
        };
        let returned: DagNodeSpec[] | null = null;
        try {
          returned = await input.replanner({
            failed: failedEntry,
            spec: failedToReplan.spec,
            inputs: inputsForReplan as NodeInputs,
            manifest: snapshotManifest(records),
          });
        } catch (err) {
          // A throwing replanner is fail-closed: the node stays failed, with the
          // failure surfaced in its reason (never aborts the run).
          failedToReplan.reason =
            `${failedToReplan.reason ?? "failed"} (replan error: ` +
            `${err instanceof Error ? err.message : String(err)})`;
          continue;
        }
        if (returned === null) {
          // No replan offered for this failure — leave it terminally failed.
          continue;
        }
        const rejection = validateReplan(failedToReplan, returned, byId);
        if (rejection) {
          // Invalid replan: leave the node failed, surface why (audit evidence).
          failedToReplan.reason = `${failedToReplan.reason ?? "failed"} (replan rejected: ${rejection})`;
          continue;
        }
        const childCount = spliceReplan(
          failedToReplan,
          returned,
          records,
          byId,
        );
        replanBudget -= 1;
        emitProgress(input, {
          type: "node_replanned",
          runId: input.runId,
          nodeId: failedToReplan.spec.id,
          childCount,
          at: input.clock.now(),
        });
        continue; // re-loop: the spliced pending nodes enter the frontier.
      }
    }

    // Resolve nodes blocked by non-done upstream into "deferred" immediately
    // (partial-failure tolerance + skip propagation). Done as a fixpoint pass.
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of records) {
        if (r.status !== "pending") continue;
        const blocker = firstBlockingDep(r, byId);
        if (blocker) {
          r.status = "deferred";
          r.reason = blocker.reason;
          emitProgress(input, {
            type: "node_deferred",
            runId: input.runId,
            nodeId: r.spec.id,
            reason: blocker.reason,
            at: input.clock.now(),
          });
          changed = true;
        }
      }
    }

    // Compute the ready frontier: pending nodes whose deps are ALL done.
    const frontier = records.filter(
      (r) =>
        r.status === "pending" &&
        r.dependsOn.every((d) => byId.get(d)?.status === "done"),
    );

    if (frontier.length === 0) {
      if (inFlight.size === 0) {
        // Nothing ready and nothing running: remaining pending (if any) are
        // resolved on the next fixpoint pass. Guard against a stuck loop.
        if (records.some((r) => r.status === "pending")) {
          // Should not happen given the fixpoint pass above, but fail safe.
          for (const r of records) {
            if (r.status === "pending") {
              r.status = "deferred";
              r.reason = "unresolved dependency";
              emitProgress(input, {
                type: "node_deferred",
                runId: input.runId,
                nodeId: r.spec.id,
                reason: "unresolved dependency",
                at: input.clock.now(),
              });
            }
          }
        }
        break;
      }
      // Wait for any in-flight node to finish, then re-evaluate the frontier.
      await Promise.race(inFlight);
      continue;
    }

    // Dispatch as many frontier nodes as concurrency allows.
    for (const r of frontier) {
      if (running >= maxConcurrency) break;
      // Mark as running so it leaves the pending set and isn't re-dispatched.
      (r as { status: NodeStatus | "pending" | "running" }).status = "running";
      running += 1;
      const p = runNode<TOutput>(r, byId, input)
        .catch((err: unknown) => {
          // Defensive: an executor that throws (instead of returning a failed
          // NodeOutcome) does not abort the run.
          r.status = "failed";
          r.output = null;
          r.reason = err instanceof Error ? err.message : String(err);
          emitProgress(input, {
            type: "node_failed",
            runId: input.runId,
            nodeId: r.spec.id,
            reason: r.reason,
            at: input.clock.now(),
          });
        })
        .finally(() => {
          running -= 1;
          inFlight.delete(p);
        });
      inFlight.add(p);
    }

    // If we dispatched nothing (all blocked by concurrency) wait for a slot.
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  // Drain any still-running tasks.
  await Promise.allSettled(inFlight);
}

// ─── Cap 4: adaptive re-planning (splice) ────────────────────────────────────

/**
 * Build the manifest-shaped snapshot the re-planner receives as context. Mirrors
 * the final manifest mapping (pending → deferred "not scheduled").
 */
function snapshotManifest<TOutput>(
  records: Array<NodeRecord<TOutput>>,
): ReadonlyArray<NodeManifestEntry<TOutput>> {
  return records.map((r) => ({
    id: r.spec.id,
    status: r.status === "pending" ? "deferred" : (r.status as NodeStatus),
    reason: r.status === "pending" ? "not scheduled" : r.reason,
    output: r.output,
    dependsOn: r.dependsOn,
    attempts: r.attempts,
  }));
}

/**
 * Validate the re-planner's returned sub-DAG against the splice contract.
 * Returns null on success, or a human-readable rejection reason on failure.
 * Validation is PURE (no mutation), so a rejected replan leaves the run intact.
 */
function validateReplan<TOutput>(
  failed: NodeRecord<TOutput>,
  returned: readonly DagNodeSpec[],
  byId: Map<string, NodeRecord<TOutput>>,
): string | null {
  if (returned.length === 0) {
    return "replanner returned an empty sub-DAG";
  }
  // Exactly one returned node MUST reuse the failed id, and it MUST be last.
  const reuseCount = returned.filter((n) => n.id === failed.spec.id).length;
  if (reuseCount === 0) {
    return `replan must contain a node reusing the failed id '${failed.spec.id}'`;
  }
  if (reuseCount > 1) {
    return `replan reuses the failed id '${failed.spec.id}' more than once`;
  }
  const last = returned[returned.length - 1];
  if (last.id !== failed.spec.id) {
    return `the failed-id node '${failed.spec.id}' must be LAST in the replan`;
  }
  // Internal id uniqueness within the returned set.
  const internalSeen = new Set<string>();
  for (const n of returned) {
    if (!n.id || n.id.trim() === "") {
      return "a replan node has an empty id";
    }
    if (internalSeen.has(n.id)) {
      return `replan introduces a duplicate id '${n.id}'`;
    }
    internalSeen.add(n.id);
  }
  // New (non-reused) ids must not collide with ANY existing node.
  for (const n of returned) {
    if (n.id === failed.spec.id) continue; // the deliberate reuse
    if (byId.has(n.id)) {
      return `replan id '${n.id}' collides with an existing node`;
    }
  }
  // Cycle / missing-dep check on the COMBINED graph (existing minus the failed
  // node's old spec, plus the returned specs). Build a temporary id→deps map.
  const combinedDeps = new Map<string, readonly string[]>();
  for (const r of byId.values()) {
    if (r.spec.id === failed.spec.id) continue; // replaced below
    combinedDeps.set(r.spec.id, r.dependsOn);
  }
  for (const n of returned) {
    combinedDeps.set(n.id, n.dependsOn ?? []);
  }
  // Missing-dep: every dep must reference a node in the combined graph.
  for (const [id, deps] of combinedDeps) {
    for (const dep of deps) {
      if (dep === id) return `replan node '${id}' depends on itself`;
      if (!combinedDeps.has(dep)) {
        return `replan node '${id}' depends on unknown node '${dep}'`;
      }
    }
  }
  // Cycle: Kahn over the combined graph.
  const indeg = new Map<string, number>();
  for (const [id, deps] of combinedDeps) indeg.set(id, deps.length);
  const dependents = new Map<string, string[]>();
  for (const [id, deps] of combinedDeps) {
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(id);
      dependents.set(dep, list);
    }
  }
  const queue = [...indeg.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  let placed = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    placed += 1;
    for (const child of dependents.get(id) ?? []) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  if (placed !== combinedDeps.size) {
    return "replan would introduce a cycle in the combined graph";
  }
  return null;
}

/**
 * Cap 4 — splice a validated re-planned sub-DAG into the live run. The earlier
 * returned nodes become FRESH pending records; the last returned node REUSES the
 * failed record's id, so the failed node's existing dependents resolve against
 * the same id (the spliced graph transparently replaces the failed work). The
 * reused record is reset to `pending` with its new spec/dependsOn; retry and
 * replan counters are reset for the fresh work.
 *
 * rootHash is NOT recomputed: the pre-execution governance hash stays the
 * original commit; re-planning is a RUNTIME audit-stream concern (a
 * `node_replanned` progress event), exactly as Cap 5 treats cancellation. The
 * spliced nodes are never folded into rootHash (replay invariant, ADR-083 #4).
 */
function spliceReplan<TOutput>(
  failed: NodeRecord<TOutput>,
  returned: readonly DagNodeSpec[],
  records: Array<NodeRecord<TOutput>>,
  byId: Map<string, NodeRecord<TOutput>>,
): number {
  const last = returned[returned.length - 1];
  // Add the fresh (non-reused) nodes first.
  for (const spec of returned) {
    if (spec.id === failed.spec.id) continue;
    const rec: NodeRecord<TOutput> = {
      spec,
      dependsOn: spec.dependsOn ?? [],
      status: "pending",
      reason: null,
      output: null,
      attempts: 0,
      retriesUsed: 0,
      replanOffered: false,
    };
    records.push(rec);
    byId.set(spec.id, rec);
  }
  // Reuse the failed record's id with the last returned spec (reset to pending).
  failed.spec = last;
  failed.dependsOn = last.dependsOn ?? [];
  failed.status = "pending";
  failed.reason = null;
  failed.output = null;
  failed.attempts = 0;
  failed.retriesUsed = 0;
  failed.replanOffered = false; // fresh work may itself fail + be re-offered
  return returned.length;
}

/**
 * Returns the first dependency that blocks this node (not done), with the
 * deferral reason, or null when all deps are done.
 */
function firstBlockingDep<TOutput>(
  r: NodeRecord<TOutput>,
  byId: Map<string, NodeRecord<TOutput>>,
): { reason: string } | null {
  for (const depId of r.dependsOn) {
    const dep = byId.get(depId);
    // dep existence is guaranteed by assertNoMissingDeps.
    const status = dep?.status;
    if (status === "failed" || status === "deferred") {
      return { reason: `upstream '${depId}' not done (${status})` };
    }
  }
  return null;
}

// ─── Single-node execution (runIf, mapOver, best-of-N) ───────────────────────

async function runNode<TOutput>(
  r: NodeRecord<TOutput>,
  byId: Map<string, NodeRecord<TOutput>>,
  input: DagRunInput<TOutput>,
): Promise<void> {
  // ── Durability resume (Wave 2): done-only short-circuit ──
  // If a journal is present and a prior run recorded this node `done`, reuse
  // its terminal outcome WITHOUT re-executing. Non-done recalls are ignored so
  // transient failures get a fresh attempt on resume. Journal errors surface
  // (they reject runNode → the node is marked failed by execute()'s catch).
  if (input.journal) {
    const recalled = await input.journal.recall(input.runId, r.spec.id);
    if (recalled && recalled.status === "done") {
      r.status = "done";
      r.output = recalled.output;
      r.reason = null;
      r.attempts = recalled.attempts;
      // Cap 5: resumed via the journal done-short-circuit (no execution).
      emitProgress(input, {
        type: "node_resumed",
        runId: input.runId,
        nodeId: r.spec.id,
        at: input.clock.now(),
      });
      emitProgress(input, {
        type: "node_done",
        runId: input.runId,
        nodeId: r.spec.id,
        output: r.output,
        at: input.clock.now(),
      });
      return; // resumed — no execution, no re-record (already persisted).
    }
  }

  await executeNode<TOutput>(r, byId, input);

  // ── Cap 4: bounded transient (own-timeout) retry ──
  // A node that settled `deferred` SPECIFICALLY due to its own scheduler-armed
  // timeout (detected via the stable OWN_TIMEOUT_REASON_PREFIX marker), and that
  // still has retries left, is reset to `pending` so the frontier loop re-runs
  // it. This is RUNTIME recovery: the deferral is NOT recorded as terminal in
  // the journal and NO terminal Cap-5 event is emitted while a retry remains —
  // only the FINAL settled outcome is journaled/emitted. Upstream-not-done,
  // runIf-skip, top-level cancel, and executor-returned deferrals are NEVER
  // retried (their reasons do not carry the marker). rootHash is untouched.
  if (isOwnTimeoutDeferral(r.status, r.reason)) {
    const bound = resolveRetryBound(r.spec, input);
    if (r.retriesUsed < bound) {
      r.retriesUsed += 1;
      r.status = "pending";
      r.reason = null;
      r.output = null;
      return; // re-enter the ready frontier; no record, no terminal emit yet.
    }
  }

  // ── Durability record (Wave 2) ──
  // Persist the node's terminal outcome idempotently after execution. Recorded
  // for every terminal status (done/deferred/failed) so the manifest is fully
  // reconstructable; only `done` short-circuits on the next resume. A record
  // rejection surfaces (rejects runNode) rather than being swallowed — in that
  // case the Cap 5 terminal event below is NOT emitted; the dispatch catch
  // emits node_failed instead, so the stream reflects the real outcome.
  if (input.journal) {
    await input.journal.record(input.runId, {
      id: r.spec.id,
      status: r.status === "pending" ? "deferred" : r.status,
      reason: r.status === "done" ? null : r.reason,
      output: r.output,
      dependsOn: r.dependsOn,
      attempts: r.attempts,
    });
  }

  // ── Cap 5: terminal transition for an EXECUTED node ──
  // (The journal-resume path above emits its own node_done and returns early.)
  emitTerminal(input, r);
}

/**
 * Cap 5: emit the terminal lifecycle event for an executed node, mapping its
 * settled record status to node_done / node_failed / node_deferred.
 */
function emitTerminal<TOutput>(
  input: DagRunInput<TOutput>,
  r: NodeRecord<TOutput>,
): void {
  if (r.status === "done") {
    emitProgress(input, {
      type: "node_done",
      runId: input.runId,
      nodeId: r.spec.id,
      output: r.output,
      at: input.clock.now(),
    });
  } else if (r.status === "failed") {
    emitProgress(input, {
      type: "node_failed",
      runId: input.runId,
      nodeId: r.spec.id,
      reason: r.reason ?? "(no reason)",
      at: input.clock.now(),
    });
  } else if (r.status === "deferred") {
    emitProgress(input, {
      type: "node_deferred",
      runId: input.runId,
      nodeId: r.spec.id,
      reason: r.reason ?? "(no reason)",
      at: input.clock.now(),
    });
  }
}

/** The actual node execution (runIf, mapOver, best-of-N, single attempt). */
async function executeNode<TOutput>(
  r: NodeRecord<TOutput>,
  byId: Map<string, NodeRecord<TOutput>>,
  input: DagRunInput<TOutput>,
): Promise<void> {
  // Resolve upstream inputs (keyed by dep id).
  const inputs: Record<string, unknown> = {};
  for (const depId of r.dependsOn) {
    inputs[depId] = byId.get(depId)?.output ?? null;
  }
  const nodeInputs = inputs as NodeInputs;

  // Conditional edge.
  if (r.spec.runIf && !r.spec.runIf(nodeInputs)) {
    r.status = "deferred";
    r.reason = "skipped";
    r.output = null;
    return;
  }

  // mapOver dynamic fan-out.
  if (r.spec.mapOver !== undefined) {
    await runMapOver<TOutput>(r, nodeInputs, input);
    return;
  }

  // Best-of-N or single attempt.
  const samples = r.spec.samples ?? 1;
  if (samples > 1) {
    await runBestOfN<TOutput>(r, nodeInputs, input, samples);
    return;
  }

  // Single attempt (samples=1): emit node_running. `attempt` carries the Cap-4
  // own-timeout retry generation (1 on the first run, 2 on the first retry, …)
  // so the live stream shows the retry; samples stays 1. With no retries this is
  // attempt=1 samples=1, byte-identical to pre-Cap-4 behaviour.
  emitProgress(input, {
    type: "node_running",
    runId: input.runId,
    nodeId: r.spec.id,
    attempt: 1 + r.retriesUsed,
    samples: 1,
    at: input.clock.now(),
  });
  const outcome = await callExecutor<TOutput>(r.spec, nodeInputs, input, 0);
  r.attempts = 1;
  applyOutcome(r, outcome);
}

/**
 * mapOver: the named upstream output MUST be an array. Fan into one executor
 * call per element (Send-API style); aggregate child outputs into an array.
 * A child failure does not fail the node — failed children are dropped from
 * the aggregate and noted in the reason; the node is `done` with the surviving
 * outputs. If EVERY child fails, the node is `failed`.
 */
async function runMapOver<TOutput>(
  r: NodeRecord<TOutput>,
  nodeInputs: NodeInputs,
  input: DagRunInput<TOutput>,
): Promise<void> {
  const mapOver = r.spec.mapOver as string;
  const arr = (nodeInputs as Record<string, unknown>)[mapOver];
  if (!Array.isArray(arr)) {
    r.status = "failed";
    r.output = null;
    r.reason = `mapOver '${mapOver}' did not resolve to an array`;
    return;
  }

  r.attempts = arr.length;
  if (arr.length === 0) {
    // Vacuously done: an empty fan-out produces an empty aggregate.
    r.status = "done";
    r.output = [] as unknown as TOutput;
    r.reason = null;
    return;
  }

  // Each child sees the same NodeInputs plus its element bound under `mapOver`,
  // and a distinct attempt index for executor sampling/determinism.
  const settled = await Promise.all(
    arr.map((element, idx) => {
      // Cap 5: node_running per fan-out child (1-based attempt, samples = fan width).
      emitProgress(input, {
        type: "node_running",
        runId: input.runId,
        nodeId: r.spec.id,
        attempt: idx + 1,
        samples: arr.length,
        at: input.clock.now(),
      });
      const childInputs = { ...nodeInputs, [mapOver]: element } as NodeInputs;
      return callExecutor<TOutput>(r.spec, childInputs, input, idx);
    }),
  );

  const succeeded = settled.filter((o) => o.status === "done");
  if (succeeded.length === 0) {
    r.status = "failed";
    r.output = null;
    r.reason = `all ${arr.length} mapOver children failed`;
    return;
  }

  const aggregate = succeeded.map((o) => o.output) as unknown as TOutput;
  r.status = "done";
  r.output = aggregate;
  r.reason =
    succeeded.length === arr.length
      ? null
      : `${arr.length - succeeded.length}/${arr.length} mapOver children failed`;
}

/**
 * Best-of-N (inline, minimal — does NOT import best-of-n.ts to avoid coupling;
 * another agent owns that module). Run `samples` attempts via the executor
 * (varying ctx.attempt), collect the `done` candidates, rank them with the
 * injected Verifier, keep the accepted-best. `accepted=null` (or zero
 * candidates) → node `failed`, fail-closed (never silently picks a bad sample).
 *
 * TODO(best-of-n): once best-of-n.ts ships, replace this inline loop with the
 * shared helper (kept inline for now per the build brief, to avoid coupling).
 */
async function runBestOfN<TOutput>(
  r: NodeRecord<TOutput>,
  nodeInputs: NodeInputs,
  input: DagRunInput<TOutput>,
  samples: number,
): Promise<void> {
  const verifier = input.verifier as Verifier<TOutput>; // presence guaranteed

  // Adaptive best-of-N (ST-BoN / adaptive-N): when `input.bestOfN` is set, run a
  // cheap initial batch and escalate to the full budget ONLY if no confident
  // winner emerged. When absent, phase1Size = samples → ONE batch, ONE verify:
  // byte-identical to the pre-adaptive scheduler (additive invariant).
  const policy = input.bestOfN;
  const earlyThreshold = policy?.earlyAcceptThreshold ?? 0.85;
  const phase1Size = policy
    ? Math.min(
        samples,
        Math.max(1, policy.initialBatch ?? Math.max(2, Math.ceil(samples / 2))),
      )
    : samples;

  // Run `count` executor attempts in parallel, ctx.attempt = startIndex+i.
  const runBatch = async (
    startIndex: number,
    count: number,
  ): Promise<TOutput[]> => {
    const outs = await Promise.all(
      Array.from({ length: count }, (_v, i) => {
        const attemptIndex = startIndex + i;
        // Cap 5: node_running per attempt (1-based attempt, samples = total N).
        emitProgress(input, {
          type: "node_running",
          runId: input.runId,
          nodeId: r.spec.id,
          attempt: attemptIndex + 1,
          samples,
          at: input.clock.now(),
        });
        return callExecutor<TOutput>(r.spec, nodeInputs, input, attemptIndex);
      }),
    );
    return outs
      .filter((o) => o.status === "done" && o.output !== null)
      .map((o) => o.output as TOutput);
  };

  const failClosedNoCandidates = (ran: number): void => {
    r.status = "failed";
    r.output = null;
    r.reason = `best-of-N: all ${ran} samples failed before verification`;
    emitProgress(input, {
      type: "node_verified",
      runId: input.runId,
      nodeId: r.spec.id,
      accepted: false,
      at: input.clock.now(),
    });
  };

  const settle = (verdict: VerifierVerdict<TOutput>, nCands: number): void => {
    emitProgress(input, {
      type: "node_verified",
      runId: input.runId,
      nodeId: r.spec.id,
      accepted: verdict.accepted !== null,
      at: input.clock.now(),
    });
    if (verdict.accepted === null) {
      r.status = "failed";
      r.output = null;
      r.reason = `best-of-N: verifier rejected all ${nCands} candidates (${verdict.reason})`;
      return;
    }
    r.status = "done";
    r.output = verdict.accepted;
    r.reason = null;
  };

  // ── Phase 1 (cheap initial batch) ──────────────────────────────────────────
  const candidates = await runBatch(0, phase1Size);
  r.attempts = phase1Size;

  // If escalation is possible, probe phase-1 candidates for a confident winner.
  const willEscalate = phase1Size < samples;
  if (willEscalate) {
    if (candidates.length > 0) {
      const probe = await verifier(candidates, {
        node: r.spec,
        inputs: nodeInputs,
      });
      // Early-accept only on an EXPLICIT high score (a verifier that exposes no
      // acceptedScore can never short-circuit — the full budget always runs).
      if (
        probe.accepted !== null &&
        typeof probe.acceptedScore === "number" &&
        probe.acceptedScore >= earlyThreshold
      ) {
        settle(probe, candidates.length); // confident → skip the rest of the budget
        return;
      }
    }
    // ── Phase 2 (escalate to the full budget) ─────────────────────────────────
    const more = await runBatch(phase1Size, samples - phase1Size);
    candidates.push(...more);
    r.attempts = samples;
  }

  if (candidates.length === 0) {
    failClosedNoCandidates(r.attempts);
    return;
  }

  const verdict: VerifierVerdict<TOutput> = await verifier(candidates, {
    node: r.spec,
    inputs: nodeInputs,
  });
  settle(verdict, candidates.length);
}

/**
 * Invoke the injected executor for one attempt; normalize thrown errors.
 *
 * Wires the per-node timeout: when `spec.timeoutMs > 0`, an AbortController is
 * armed and passed to the executor via `ctx.signal`. If the timeout fires
 * before the executor settles, the node becomes "deferred" (a slow branch must
 * not block the rest of the DAG — partial-fan-in resilience). The executor is
 * expected to observe the signal and stop cooperatively; the timeout race is
 * the hard backstop either way. The timer is always cleared to avoid a leak.
 */
async function callExecutor<TOutput>(
  spec: DagNodeSpec,
  inputs: NodeInputs,
  input: DagRunInput<TOutput>,
  attempt: number,
): Promise<NodeOutcome<TOutput>> {
  const timeoutMs = spec.timeoutMs ?? 0;
  const topSignal = input.signal;
  // Cap 5: a per-node controller is needed when there is a timeout OR a
  // top-level cancel signal, so the executor's ctx.signal aborts if EITHER
  // fires (combined). With neither, we pass no signal (byte-identical to before).
  const needsController = timeoutMs > 0 || topSignal !== undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onTopAbort: (() => void) | undefined;
  try {
    if (needsController) {
      controller = new AbortController();
      // Combine: top-level cancel aborts the node controller.
      if (topSignal) {
        if (topSignal.aborted) {
          controller.abort();
        } else {
          onTopAbort = () => controller?.abort();
          topSignal.addEventListener("abort", onTopAbort, { once: true });
        }
      }
    }
    if (timeoutMs > 0 && controller) {
      const nodeController = controller;
      const deferred = new Promise<NodeOutcome<TOutput>>((resolve) => {
        timer = setTimeout(() => {
          nodeController.abort();
          resolve({
            status: "deferred",
            output: null,
            reason: `${OWN_TIMEOUT_REASON_PREFIX} node timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      });
      return await Promise.race([
        input.executor(spec, inputs, {
          attempt,
          signal: nodeController.signal,
        }),
        deferred,
      ]);
    }
    // No timeout: pass the (cancel-only) signal when present, else nothing.
    return await input.executor(
      spec,
      inputs,
      controller ? { attempt, signal: controller.signal } : { attempt },
    );
  } catch (err) {
    return {
      status: "failed",
      output: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (topSignal && onTopAbort) {
      topSignal.removeEventListener("abort", onTopAbort);
    }
  }
}

/** Copy a NodeOutcome into the node record. */
function applyOutcome<TOutput>(
  r: NodeRecord<TOutput>,
  outcome: NodeOutcome<TOutput>,
): void {
  r.status = outcome.status;
  r.output = outcome.status === "done" ? outcome.output : null;
  r.reason = outcome.status === "done" ? null : (outcome.reason ?? null);
}

// ─── Replay-safe governance rootHash ─────────────────────────────────────────

/**
 * rootHash = sha256(canonical({ adrEco, nodes: [{id, dependsOn}, ...] })).
 *
 * Commits ONLY to PRE-EXECUTION governance fields, never to runtime status or
 * outputs, so the same DAG yields a byte-identical hash regardless of how
 * execution unfolds (ADR-ECO-083 property 4, replay). Node fingerprints are
 * sorted by id so node-array ordering does not change the hash.
 */
async function computeRootHash<TOutput>(
  adrEco: string,
  records: Array<NodeRecord<TOutput>>,
): Promise<string> {
  const nodeFingerprints = records
    .map((r) => ({
      id: r.spec.id,
      dependsOn: [...r.dependsOn].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const payload = { adrEco, nodes: nodeFingerprints };
  return sha256(canonicalize(payload));
}
