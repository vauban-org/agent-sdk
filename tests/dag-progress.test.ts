/**
 * dag-progress.test.ts — Cap 5: live progress streaming + mid-flight cancel.
 *
 * Adversarial coverage:
 *  - additive invariant: no-sink run is byte-identical to a run without progress.
 *  - happy DAG emits the expected ordered lifecycle sequence.
 *  - best-of-N emits node_running per attempt (1..N) + node_verified.
 *  - a throwing sink NEVER breaks the run (fail-soft).
 *  - mid-flight cancel (already-aborted signal): pending → deferred "cancelled",
 *    workflow_settled status "CANCELLED".
 *  - journal resume emits node_resumed (not node_running) for the short-circuit.
 *  - rootHash is UNCHANGED by progress/cancel (runtime, not governance).
 */

import { describe, it, expect } from "vitest";
import { runDag } from "../src/orchestration/dag/scheduler.js";
import type {
  DagNodeSpec,
  DagRunInput,
  NodeExecutor,
  NodeInputs,
  NodeManifestEntry,
  NodeOutcome,
  StepJournal,
  Verifier,
  WorkflowProgressEvent,
  WorkflowProgressSink,
} from "../src/orchestration/dag/contracts.js";

const clock = { now: () => 0 };

function node(
  id: string,
  deps: string[] = [],
  rest: Partial<DagNodeSpec> = {},
): DagNodeSpec {
  return { id, task: `task ${id}`, dependsOn: deps, ...rest };
}

function echoExecutor(): NodeExecutor<unknown> {
  return async (n) => ({ status: "done", output: `${n.id}:done` });
}

function baseInput(
  nodes: readonly DagNodeSpec[],
  executor: NodeExecutor<unknown>,
  extra: Partial<DagRunInput<unknown>> = {},
): DagRunInput<unknown> {
  return {
    nodes,
    executor,
    clock,
    runId: "run-1",
    adrEco: "ADR-ECO-083",
    ...extra,
  };
}

/** A capturing sink that records every event in order. */
function captureSink(): {
  sink: WorkflowProgressSink<unknown>;
  events: Array<WorkflowProgressEvent<unknown>>;
} {
  const events: Array<WorkflowProgressEvent<unknown>> = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

const types = (events: Array<WorkflowProgressEvent<unknown>>): string[] =>
  events.map((e) => e.type);

describe("Cap 5 — additive invariant", () => {
  it("no-sink run is byte-identical to a run without progress field", async () => {
    const nodes = [node("A"), node("B", ["A"]), node("C", ["A"])];
    const withoutField = await runDag(baseInput(nodes, echoExecutor()));
    // Explicitly pass progress: undefined — must be identical (no emits anyway).
    const withUndefined = await runDag(
      baseInput(nodes, echoExecutor(), { progress: undefined }),
    );
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(withoutField));
  });

  it("a sink does NOT change the manifest (progress is observational)", async () => {
    const nodes = [node("A"), node("B", ["A"])];
    const baseline = await runDag(baseInput(nodes, echoExecutor()));
    const { sink } = captureSink();
    const withSink = await runDag(
      baseInput(nodes, echoExecutor(), { progress: sink }),
    );
    expect(JSON.stringify(withSink)).toBe(JSON.stringify(baseline));
  });
});

describe("Cap 5 — happy DAG event sequence", () => {
  it("emits workflow_started → node lifecycle → workflow_settled DONE", async () => {
    const { sink, events } = captureSink();
    await runDag(
      baseInput([node("A"), node("B", ["A"])], echoExecutor(), {
        progress: sink,
      }),
    );
    const seq = types(events);
    expect(seq[0]).toBe("workflow_started");
    expect(seq[seq.length - 1]).toBe("workflow_settled");

    // A runs (started → running → done) before B does.
    const aRunning = seq.indexOf("node_running");
    const aDone = seq.indexOf("node_done");
    expect(aRunning).toBeGreaterThan(0);
    expect(aDone).toBeGreaterThan(aRunning);

    // workflow_started carries the node count.
    const started = events[0];
    expect(started.type === "workflow_started" && started.nodeCount).toBe(2);

    // settled is DONE with correct summary.
    const settled = events[events.length - 1];
    expect(settled.type).toBe("workflow_settled");
    if (settled.type === "workflow_settled") {
      expect(settled.status).toBe("DONE");
      expect(settled.total).toBe(2);
      expect(settled.done).toBe(2);
      expect(settled.deferred).toBe(0);
      expect(settled.failed).toBe(0);
    }

    // exactly two node_running (one per node, single attempt) and two node_done.
    expect(seq.filter((t) => t === "node_running")).toHaveLength(2);
    expect(seq.filter((t) => t === "node_done")).toHaveLength(2);

    // every event carries the runId.
    for (const e of events) expect(e.runId).toBe("run-1");
  });

  it("a single non-sampled node emits node_running attempt=1 samples=1", async () => {
    const { sink, events } = captureSink();
    await runDag(baseInput([node("solo")], echoExecutor(), { progress: sink }));
    const running = events.find((e) => e.type === "node_running");
    expect(running).toBeDefined();
    if (running && running.type === "node_running") {
      expect(running.attempt).toBe(1);
      expect(running.samples).toBe(1);
    }
  });
});

describe("Cap 5 — best-of-N progress", () => {
  it("emits node_running per attempt (1..N) + node_verified", async () => {
    const seenAttempts: number[] = [];
    const executor: NodeExecutor<unknown> = async (_n, _i, ctx) => {
      seenAttempts.push(ctx.attempt);
      return { status: "done", output: `cand-${ctx.attempt}` };
    };
    // verifier accepts the first candidate.
    const verifier: Verifier<unknown> = async (cands) => ({
      accepted: cands[0],
      acceptedIndex: 0,
      reason: "first",
    });
    const { sink, events } = captureSink();
    await runDag(
      baseInput([node("gen", [], { samples: 3 })], executor, {
        progress: sink,
        verifier,
      }),
    );
    const running = events.filter((e) => e.type === "node_running");
    expect(running).toHaveLength(3);
    const attempts = running
      .map((e) => (e.type === "node_running" ? e.attempt : -1))
      .sort();
    expect(attempts).toEqual([1, 2, 3]);
    for (const e of running) {
      if (e.type === "node_running") expect(e.samples).toBe(3);
    }
    const verified = events.find((e) => e.type === "node_verified");
    expect(verified).toBeDefined();
    if (verified && verified.type === "node_verified") {
      expect(verified.accepted).toBe(true);
    }
  });

  it("node_verified accepted=false when the verifier rejects all (fail-closed)", async () => {
    const executor: NodeExecutor<unknown> = async (_n, _i, ctx) => ({
      status: "done",
      output: `cand-${ctx.attempt}`,
    });
    const verifier: Verifier<unknown> = async () => ({
      accepted: null,
      acceptedIndex: -1,
      reason: "all rejected",
    });
    const { sink, events } = captureSink();
    const m = await runDag(
      baseInput([node("gen", [], { samples: 2 })], executor, {
        progress: sink,
        verifier,
      }),
    );
    const verified = events.find((e) => e.type === "node_verified");
    expect(verified?.type === "node_verified" && verified.accepted).toBe(false);
    // and the node failed terminally.
    expect(m.nodes[0]?.status).toBe("failed");
    expect(types(events)).toContain("node_failed");
  });
});

describe("Cap 5 — fail-soft sink", () => {
  it("a throwing sink does NOT break the DAG (manifest still correct)", async () => {
    const throwingSink: WorkflowProgressSink<unknown> = {
      emit: () => {
        throw new Error("sink boom");
      },
    };
    const nodes = [node("A"), node("B", ["A"])];
    const baseline = await runDag(baseInput(nodes, echoExecutor()));
    const withThrowing = await runDag(
      baseInput(nodes, echoExecutor(), { progress: throwingSink }),
    );
    expect(JSON.stringify(withThrowing)).toBe(JSON.stringify(baseline));
    expect(withThrowing.workflowStatus).toBe("DONE");
    expect(withThrowing.summary.done).toBe(2);
  });
});

describe("Cap 5 — mid-flight cancel", () => {
  it("already-aborted signal: pending → deferred 'cancelled', settled CANCELLED", async () => {
    const ac = new AbortController();
    ac.abort();
    const { sink, events } = captureSink();
    const nodes = [node("A"), node("B", ["A"]), node("C")];
    const m = await runDag(
      baseInput(nodes, echoExecutor(), { progress: sink, signal: ac.signal }),
    );
    // No node ran: all pending → deferred "cancelled".
    for (const n of m.nodes) {
      expect(n.status).toBe("deferred");
      expect(n.reason).toBe("cancelled");
    }
    expect(m.workflowStatus).toBe("FAILED"); // 0 done → FAILED manifest status
    // but the progress stream reports CANCELLED.
    const settled = events[events.length - 1];
    expect(settled?.type).toBe("workflow_settled");
    if (settled?.type === "workflow_settled") {
      expect(settled.status).toBe("CANCELLED");
      expect(settled.deferred).toBe(3);
    }
    // each cancelled node emitted node_deferred "cancelled".
    const cancelled = events.filter(
      (e) => e.type === "node_deferred" && e.reason === "cancelled",
    );
    expect(cancelled).toHaveLength(3);
    // no node_running emitted (nothing launched).
    expect(types(events)).not.toContain("node_running");
  });

  it("threads the cancel signal into the per-node executor ctx.signal", async () => {
    // A timeout-less node with a live (non-aborted) top signal should still
    // receive a ctx.signal (so an in-flight executor can observe cancel).
    let sawSignal = false;
    const ac = new AbortController();
    const executor: NodeExecutor<unknown> = async (_n, _i, ctx) => {
      sawSignal = ctx.signal !== undefined;
      return { status: "done", output: "ok" };
    };
    await runDag(baseInput([node("A")], executor, { signal: ac.signal }));
    expect(sawSignal).toBe(true);
  });
});

describe("Cap 5 — journal resume emits node_resumed", () => {
  it("a recalled done node emits node_resumed (not node_running) + node_done", async () => {
    const recalledEntry: NodeManifestEntry<unknown> = {
      id: "A",
      status: "done",
      reason: null,
      output: "from-journal",
      dependsOn: [],
      attempts: 1,
    };
    const journal: StepJournal<unknown> = {
      recall: async (_runId, nodeId) =>
        nodeId === "A" ? recalledEntry : undefined,
      record: async () => {},
    };
    // executor should NOT be called for A (it's resumed). Track invocations.
    const calledFor: string[] = [];
    const executor: NodeExecutor<unknown> = async (n) => {
      calledFor.push(n.id);
      return { status: "done", output: `${n.id}:fresh` };
    };
    const { sink, events } = captureSink();
    const m = await runDag(
      baseInput([node("A"), node("B", ["A"])], executor, {
        progress: sink,
        journal,
      }),
    );
    // A resumed without execution; B executed fresh.
    expect(calledFor).toEqual(["B"]);
    expect(m.nodes.find((n) => n.id === "A")?.output).toBe("from-journal");

    // A's stream: node_resumed then node_done, and NO node_running for A.
    const seq = types(events);
    expect(seq).toContain("node_resumed");
    const resumedIdx = seq.indexOf("node_resumed");
    // the event right after node_resumed is node_done for A.
    expect(seq[resumedIdx + 1]).toBe("node_done");
    // node_running was emitted for B only (exactly one).
    expect(seq.filter((t) => t === "node_running")).toHaveLength(1);
  });
});

describe("Cap 5 — rootHash unchanged by progress/cancel", () => {
  it("rootHash is identical with no-sink, with-sink, and cancelled runs", async () => {
    const nodes = [node("A"), node("B", ["A"])];
    const plain = await runDag(baseInput(nodes, echoExecutor()));
    const { sink } = captureSink();
    const withProgress = await runDag(
      baseInput(nodes, echoExecutor(), { progress: sink }),
    );
    const ac = new AbortController();
    ac.abort();
    const cancelled = await runDag(
      baseInput(nodes, echoExecutor(), { signal: ac.signal }),
    );
    expect(withProgress.rootHash).toBe(plain.rootHash);
    expect(cancelled.rootHash).toBe(plain.rootHash);
  });
});
