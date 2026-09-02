/**
 * dag-cap4-replan.test.ts — Cap 4 (adaptive re-planning + bounded transient
 * retry) unit tests for the DAG scheduler.
 *
 * Part A — bounded own-timeout retry:
 *  - a node that times out N times then succeeds on retry → done
 *  - a node that times out past the bound → deferred
 *  - upstream / runIf-skip / cancel deferrals are NEVER retried
 *  - bound=0 is byte-identical to today (no retry)
 *  - per-node maxTimeoutRetries overrides the global default
 *
 * Part B — re-planner splice:
 *  - failed node + 2-node sub-DAG (last reuses id) → done + dependents resolve
 *  - replanner returning null → node stays failed (today's behaviour)
 *  - invalid replan (missing id / collision / cycle) → rejected, stays failed
 *  - maxReplans budget exhausted → no further replans
 *  - replanner OFF (undefined) → byte-identical to today
 */

import { describe, it, expect } from "vitest";
import { runDag } from "../src/orchestration/dag/scheduler.js";
import type {
  DagNodeSpec,
  DagRunInput,
  NodeExecutor,
  NodeInputs,
  NodeOutcome,
  RePlanner,
  WorkflowProgressEvent,
  WorkflowProgressSink,
} from "../src/orchestration/dag/contracts.js";

const clock = { now: () => 0 };

function baseInput(
  nodes: readonly DagNodeSpec[],
  executor: NodeExecutor<unknown>,
  extra: Partial<DagRunInput<unknown>> = {},
): DagRunInput<unknown> {
  return {
    nodes,
    executor,
    clock,
    runId: "run-cap4",
    adrEco: "ADR-ECO-083",
    ...extra,
  };
}

function node(
  id: string,
  deps: string[] = [],
  rest: Partial<DagNodeSpec> = {},
): DagNodeSpec {
  return { id, task: `task ${id}`, dependsOn: deps, ...rest };
}

function manifestById(m: { nodes: ReadonlyArray<{ id: string }> }) {
  return new Map(m.nodes.map((n) => [n.id, n]));
}

function collectSink(): {
  sink: WorkflowProgressSink<unknown>;
  events: WorkflowProgressEvent<unknown>[];
} {
  const events: WorkflowProgressEvent<unknown>[] = [];
  return { events, sink: { emit: (e) => events.push(e) } };
}

// ─── Part A — bounded own-timeout retry ──────────────────────────────────────

describe("Cap 4 Part A — bounded own-timeout retry", () => {
  it("retries a node that times out then succeeds on retry → done", async () => {
    let calls = 0;
    // First 2 attempts never resolve (force scheduler timeout); 3rd resolves.
    const exec: NodeExecutor<unknown> = async (n, _i, ctx) => {
      calls += 1;
      if (calls <= 2) {
        return await new Promise<NodeOutcome<unknown>>((resolve) => {
          ctx.signal?.addEventListener("abort", () =>
            resolve({ status: "done", output: "ignored-by-timeout" }),
          );
        });
      }
      return { status: "done", output: `${n.id}:ok` };
    };
    const m = await runDag(
      baseInput(
        [node("slow", [], { timeoutMs: 10, maxTimeoutRetries: 2 })],
        exec,
      ),
    );
    const slow = manifestById(m).get("slow");
    expect(slow?.status).toBe("done");
    expect(slow?.output).toBe("slow:ok");
    expect(calls).toBe(3); // 2 timeouts + 1 success
  });

  it("times out past the bound → terminally deferred (timeout reason)", async () => {
    const exec: NodeExecutor<unknown> = async (_n, _i, ctx) =>
      await new Promise<NodeOutcome<unknown>>((resolve) => {
        ctx.signal?.addEventListener("abort", () =>
          resolve({ status: "done", output: "x" }),
        );
      });
    const m = await runDag(
      baseInput(
        [node("slow", [], { timeoutMs: 10, maxTimeoutRetries: 1 })],
        exec,
      ),
    );
    const slow = manifestById(m).get("slow");
    expect(slow?.status).toBe("deferred");
    expect(slow?.reason).toMatch(/timeout:/);
    expect(slow?.reason).toMatch(/timed out after 10ms/);
  });

  it("does NOT retry an upstream-not-done deferral", async () => {
    let bCalls = 0;
    const exec: NodeExecutor<unknown> = async (n, _i, _ctx) => {
      if (n.id === "A")
        return { status: "failed", output: null, reason: "boom" };
      if (n.id === "B") {
        bCalls += 1;
        return { status: "done", output: "B" };
      }
      return { status: "done", output: n.id };
    };
    const m = await runDag(
      baseInput([node("A"), node("B", ["A"], { maxTimeoutRetries: 5 })], exec),
    );
    const b = manifestById(m).get("B");
    expect(b?.status).toBe("deferred");
    expect(b?.reason).toMatch(/upstream 'A' not done/);
    expect(bCalls).toBe(0); // never executed, never retried
  });

  it("does NOT retry a runIf-skip deferral", async () => {
    let calls = 0;
    const exec: NodeExecutor<unknown> = async (n) => {
      calls += 1;
      return { status: "done", output: n.id };
    };
    const m = await runDag(
      baseInput(
        [node("S", [], { runIf: () => false, maxTimeoutRetries: 5 })],
        exec,
      ),
    );
    const s = manifestById(m).get("S");
    expect(s?.status).toBe("deferred");
    expect(s?.reason).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("does NOT retry a cancel deferral", async () => {
    const ctrl = new AbortController();
    let starts = 0;
    const exec: NodeExecutor<unknown> = async (_n, _i, ctx) => {
      starts += 1;
      ctrl.abort(); // cancel the whole run as soon as the first node starts
      return await new Promise<NodeOutcome<unknown>>((resolve) => {
        ctx.signal?.addEventListener("abort", () =>
          resolve({ status: "deferred", output: null, reason: "aborted" }),
        );
      });
    };
    const m = await runDag(
      baseInput(
        [
          node("A", [], { timeoutMs: 1000, maxTimeoutRetries: 5 }),
          node("B", [], { timeoutMs: 1000, maxTimeoutRetries: 5 }),
        ],
        exec,
        { signal: ctrl.signal },
      ),
    );
    // B → deferred via cancel (reason "cancelled" or "not scheduled" depending
    // on the dispatch race), NEVER a timeout retry. The invariant under test is:
    // no own-timeout retry of a cancelled run (a timeout reason would prove a
    // retry path fired). starts stays bounded (no retry storm).
    const b = manifestById(m).get("B");
    expect(b?.status).toBe("deferred");
    expect(b?.reason).not.toMatch(/timeout:/);
    expect(starts).toBeLessThanOrEqual(2); // no retry storms
  });

  it("bound=0 (default) is byte-identical: one timeout → deferred, no retry", async () => {
    let calls = 0;
    const exec: NodeExecutor<unknown> = async (_n, _i, ctx) => {
      calls += 1;
      return await new Promise<NodeOutcome<unknown>>((resolve) => {
        ctx.signal?.addEventListener("abort", () =>
          resolve({ status: "done", output: "x" }),
        );
      });
    };
    const m = await runDag(
      baseInput([node("slow", [], { timeoutMs: 10 })], exec),
    );
    expect(manifestById(m).get("slow")?.status).toBe("deferred");
    expect(calls).toBe(1); // executed exactly once, no retry
  });

  it("global defaultMaxTimeoutRetries applies when the node has none", async () => {
    let calls = 0;
    const exec: NodeExecutor<unknown> = async (n, _i, ctx) => {
      calls += 1;
      if (calls <= 1) {
        return await new Promise<NodeOutcome<unknown>>((resolve) => {
          ctx.signal?.addEventListener("abort", () =>
            resolve({ status: "done", output: "ignored" }),
          );
        });
      }
      return { status: "done", output: `${n.id}:ok` };
    };
    const m = await runDag(
      baseInput([node("slow", [], { timeoutMs: 10 })], exec, {
        defaultMaxTimeoutRetries: 1,
      }),
    );
    expect(manifestById(m).get("slow")?.status).toBe("done");
    expect(calls).toBe(2);
  });

  it("emits node_running with an incremented attempt on retry", async () => {
    let calls = 0;
    const exec: NodeExecutor<unknown> = async (n, _i, ctx) => {
      calls += 1;
      if (calls <= 1) {
        return await new Promise<NodeOutcome<unknown>>((resolve) => {
          ctx.signal?.addEventListener("abort", () =>
            resolve({ status: "done", output: "ignored" }),
          );
        });
      }
      return { status: "done", output: n.id };
    };
    const { sink, events } = collectSink();
    await runDag(
      baseInput(
        [node("slow", [], { timeoutMs: 10, maxTimeoutRetries: 1 })],
        exec,
        {
          progress: sink,
        },
      ),
    );
    const running = events.filter((e) => e.type === "node_running") as Array<
      Extract<WorkflowProgressEvent<unknown>, { type: "node_running" }>
    >;
    expect(running.map((r) => r.attempt)).toEqual([1, 2]);
  });
});

// ─── Part B — re-planner splice ──────────────────────────────────────────────

describe("Cap 4 Part B — re-planner splice", () => {
  it("splices a 2-node sub-DAG (last reuses id) → node done + dependents resolve", async () => {
    // X fails; replanner returns [X1(fresh), X(reuse, deps X1)]. D depends on X.
    // The reused id "X" runs distinctly after replan because the executor
    // branches on the `replanned` flag (first run fails, post-splice succeeds).
    let replanned = false;
    const exec2: NodeExecutor<unknown> = async (n, inputs) => {
      if (n.id === "X" && !replanned)
        return { status: "failed", output: null, reason: "boom" };
      if (n.id === "X1") return { status: "done", output: "x1-out" };
      if (n.id === "X")
        return {
          status: "done",
          output: `redo(${(inputs as Record<string, unknown>)["X1"]})`,
        };
      if (n.id === "D")
        return {
          status: "done",
          output: `D(${(inputs as Record<string, unknown>)["X"]})`,
        };
      return { status: "done", output: n.id };
    };
    const replanner: RePlanner<unknown> = async () => {
      replanned = true;
      return [
        node("X1"),
        node("X", ["X1"]), // reuse id, depends on the fresh node, runs last
      ];
    };
    const m = await runDag(
      baseInput([node("X"), node("D", ["X"])], exec2, {
        replanner,
        maxReplans: 2,
      }),
    );
    const byId = manifestById(m);
    expect(byId.get("X")?.status).toBe("done");
    expect(byId.get("X")?.output).toBe("redo(x1-out)");
    expect(byId.get("X1")?.status).toBe("done");
    expect(byId.get("D")?.status).toBe("done");
    expect(byId.get("D")?.output).toBe("D(redo(x1-out))");
  });

  it("emits node_replanned with the child count", async () => {
    let replanned = false;
    const exec: NodeExecutor<unknown> = async (n) => {
      if (n.id === "X" && !replanned)
        return { status: "failed", output: null, reason: "boom" };
      return { status: "done", output: n.id };
    };
    const replanner: RePlanner<unknown> = async () => {
      replanned = true;
      return [node("X1"), node("X", ["X1"])];
    };
    const { sink, events } = collectSink();
    await runDag(
      baseInput([node("X")], exec, {
        replanner,
        maxReplans: 1,
        progress: sink,
      }),
    );
    const rp = events.filter((e) => e.type === "node_replanned") as Array<
      Extract<WorkflowProgressEvent<unknown>, { type: "node_replanned" }>
    >;
    expect(rp).toHaveLength(1);
    expect(rp[0].nodeId).toBe("X");
    expect(rp[0].childCount).toBe(2);
  });

  it("replanner returning null → node stays failed (today's behaviour)", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    const replanner: RePlanner<unknown> = async () => null;
    const m = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 2 }),
    );
    expect(manifestById(m).get("X")?.status).toBe("failed");
    expect(manifestById(m).get("X")?.reason).toBe("boom");
  });

  it("rejects a replan missing the failed id → stays failed with reason", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    const replanner: RePlanner<unknown> = async () => [
      node("Y"),
      node("Z", ["Y"]),
    ];
    const m = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 2 }),
    );
    const x = manifestById(m).get("X");
    expect(x?.status).toBe("failed");
    expect(x?.reason).toMatch(/replan rejected/);
    expect(x?.reason).toMatch(/reusing the failed id/);
  });

  it("rejects a replan colliding with an existing non-failed id → stays failed", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    // Returns a fresh node id "keep" which already exists in the graph.
    const replanner: RePlanner<unknown> = async () => [
      node("keep"),
      node("X", ["keep"]),
    ];
    const m = await runDag(
      baseInput([node("X"), node("keep")], exec, {
        replanner,
        maxReplans: 2,
      }),
    );
    const x = manifestById(m).get("X");
    expect(x?.status).toBe("failed");
    expect(x?.reason).toMatch(/collides with an existing node/);
  });

  it("rejects a replan introducing a cycle → stays failed", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    // X1 depends on X(reuse) and X depends on X1 → cycle.
    const replanner: RePlanner<unknown> = async () => [
      node("X1", ["X"]),
      node("X", ["X1"]),
    ];
    const m = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 2 }),
    );
    const x = manifestById(m).get("X");
    expect(x?.status).toBe("failed");
    expect(x?.reason).toMatch(/cycle/);
  });

  it("maxReplans budget exhausted → no further replans (node stays failed)", async () => {
    // The reused node keeps failing; with budget 1 it is replanned once, then
    // the second failure is NOT replanned (budget gone) → terminally failed.
    let replanCalls = 0;
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    const replanner: RePlanner<unknown> = async () => {
      replanCalls += 1;
      return [node(`fresh${replanCalls}`), node("X", [`fresh${replanCalls}`])];
    };
    const m = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 1 }),
    );
    expect(manifestById(m).get("X")?.status).toBe("failed");
    expect(replanCalls).toBe(1); // offered once, budget then exhausted
  });

  it("replanner OFF (undefined) → byte-identical to today (failed stays failed)", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    const m = await runDag(baseInput([node("X"), node("D", ["X"])], exec));
    const byId = manifestById(m);
    expect(byId.get("X")?.status).toBe("failed");
    expect(byId.get("D")?.status).toBe("deferred");
    expect(byId.get("D")?.reason).toMatch(/upstream 'X' not done/);
  });

  it("a throwing replanner is fail-closed (node stays failed, reason surfaced)", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "X"
        ? { status: "failed", output: null, reason: "boom" }
        : { status: "done", output: n.id };
    const replanner: RePlanner<unknown> = async () => {
      throw new Error("replanner crashed");
    };
    const m = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 2 }),
    );
    const x = manifestById(m).get("X");
    expect(x?.status).toBe("failed");
    expect(x?.reason).toMatch(/replan error: replanner crashed/);
  });

  it("rootHash is unchanged by replanning (commits to pre-exec graph only)", async () => {
    let replanned = false;
    const exec: NodeExecutor<unknown> = async (n) => {
      if (n.id === "X" && !replanned)
        return { status: "failed", output: null, reason: "boom" };
      return { status: "done", output: n.id };
    };
    const replanner: RePlanner<unknown> = async () => {
      replanned = true;
      return [node("X1"), node("X", ["X1"])];
    };
    const withReplan = await runDag(
      baseInput([node("X")], exec, { replanner, maxReplans: 1 }),
    );
    // Same pre-exec graph, no replanner: rootHash must match (replan is runtime).
    const noReplan = await runDag(
      baseInput([node("X")], async (n) => ({ status: "done", output: n.id })),
    );
    expect(withReplan.rootHash).toBe(noReplan.rootHash);
  });
});
