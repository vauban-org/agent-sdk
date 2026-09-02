/**
 * dag-scheduler.test.ts — unit tests for the result-driven DAG scheduler.
 *
 * Uses a fake NodeExecutor + fake Verifier (no real LLM, no I/O). Covers:
 *  - linear chain A→B→C (input propagation)
 *  - diamond A→{B,C}→D (B,C run in parallel)
 *  - mapOver dynamic fan-out
 *  - runIf conditional skip (+ skip propagation to dependents)
 *  - cycle detection throws (before any execution)
 *  - partial failure (one node fails, independent branch still done)
 *  - best-of-N picks the verified sample; fail-closed when verifier rejects all
 *  - rootHash deterministic + excludes runtime status
 */

import { describe, it, expect, vi } from "vitest";
import {
  runDag,
  DagSchedulerError,
} from "../src/orchestration/dag/scheduler.js";
import type {
  DagNodeSpec,
  DagRunInput,
  NodeExecutor,
  NodeInputs,
  NodeOutcome,
  Verifier,
} from "../src/orchestration/dag/contracts.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const clock = { now: () => 0 };

/** Echo executor: output = `<id>:done` unless a per-id override is supplied. */
function echoExecutor(
  overrides: Record<
    string,
    (inputs: NodeInputs, attempt: number) => NodeOutcome<unknown>
  > = {},
): NodeExecutor<unknown> {
  return async (node, inputs, ctx) => {
    const o = overrides[node.id];
    if (o) return o(inputs, ctx.attempt);
    return { status: "done", output: `${node.id}:done` };
  };
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

// ─── Linear chain ────────────────────────────────────────────────────────────

describe("runDag — linear chain A→B→C", () => {
  it("runs in dependency order and propagates upstream outputs", async () => {
    const seen: Record<string, NodeInputs> = {};
    const exec: NodeExecutor<unknown> = async (n, inputs) => {
      seen[n.id] = inputs;
      return { status: "done", output: `${n.id}:ok` };
    };
    const m = await runDag(
      baseInput([node("A"), node("B", ["A"]), node("C", ["B"])], exec),
    );

    expect(m.workflowStatus).toBe("DONE");
    expect(m.summary).toEqual({ total: 3, done: 3, deferred: 0, failed: 0 });
    // B saw A's output; C saw B's output.
    expect(seen.A).toEqual({});
    expect(seen.B).toEqual({ A: "A:ok" });
    expect(seen.C).toEqual({ B: "B:ok" });
  });
});

// ─── Diamond / parallelism ───────────────────────────────────────────────────

describe("runDag — diamond A→{B,C}→D", () => {
  it("runs B and C in parallel (overlapping execution)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const exec: NodeExecutor<unknown> = async (n) => {
      if (n.id === "B" || n.id === "C") {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
      }
      return { status: "done", output: `${n.id}` };
    };
    const m = await runDag(
      baseInput(
        [node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])],
        exec,
      ),
    );
    expect(m.workflowStatus).toBe("DONE");
    expect(m.summary.done).toBe(4);
    expect(maxConcurrent).toBe(2); // B and C overlapped
    // D saw both upstream outputs.
    const d = m.nodes.find((n) => n.id === "D");
    expect(d?.status).toBe("done");
  });

  it("respects maxConcurrency", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const exec: NodeExecutor<unknown> = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
      return { status: "done", output: "x" };
    };
    // Four independent roots, but cap at 2.
    const m = await runDag(
      baseInput([node("A"), node("B"), node("C"), node("D")], exec, {
        maxConcurrency: 2,
      }),
    );
    expect(m.summary.done).toBe(4);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ─── mapOver dynamic fan-out ─────────────────────────────────────────────────

describe("runDag — mapOver dynamic fan-out", () => {
  it("fans into one call per upstream array element and aggregates", async () => {
    const calls: unknown[] = [];
    const exec: NodeExecutor<unknown> = async (n, inputs) => {
      if (n.id === "src") {
        return { status: "done", output: ["a", "b", "c"] };
      }
      // mapper: receives one element bound under the mapOver key
      const el = (inputs as Record<string, unknown>).src;
      calls.push(el);
      return { status: "done", output: `mapped:${el}` };
    };
    const m = await runDag(
      baseInput(
        [node("src"), node("mapper", ["src"], { mapOver: "src" })],
        exec,
      ),
    );
    expect(m.workflowStatus).toBe("DONE");
    expect(calls.sort()).toEqual(["a", "b", "c"]);
    const mapper = m.nodes.find((n) => n.id === "mapper");
    expect(mapper?.status).toBe("done");
    expect(mapper?.attempts).toBe(3);
    expect(mapper?.output).toEqual(["mapped:a", "mapped:b", "mapped:c"]);
  });

  it("fails the node when mapOver dep is not an array", async () => {
    const exec: NodeExecutor<unknown> = async (n) =>
      n.id === "src"
        ? { status: "done", output: "not-an-array" }
        : { status: "done", output: "x" };
    const m = await runDag(
      baseInput(
        [node("src"), node("mapper", ["src"], { mapOver: "src" })],
        exec,
      ),
    );
    const mapper = manifestById(m).get("mapper");
    expect(mapper?.status).toBe("failed");
  });
});

// ─── runIf conditional skip ──────────────────────────────────────────────────

describe("runDag — runIf conditional skip", () => {
  it("defers a node when runIf is false and propagates skip to dependents", async () => {
    const exec = echoExecutor();
    const m = await runDag(
      baseInput(
        [node("A"), node("B", ["A"], { runIf: () => false }), node("C", ["B"])],
        exec,
      ),
    );
    const byId = manifestById(m);
    expect(byId.get("A")?.status).toBe("done");
    expect(byId.get("B")?.status).toBe("deferred");
    expect((byId.get("B") as { reason: string }).reason).toBe("skipped");
    // C depends on the skipped B → deferred (skip propagates).
    expect(byId.get("C")?.status).toBe("deferred");
    expect(m.workflowStatus).toBe("DONE"); // A is done
  });

  it("runs the node when runIf is true and sees the upstream input", async () => {
    let sawInput: unknown;
    const exec: NodeExecutor<unknown> = async (n, inputs) => {
      if (n.id === "B") sawInput = (inputs as Record<string, unknown>).A;
      return { status: "done", output: `${n.id}` };
    };
    const m = await runDag(
      baseInput(
        [
          node("A"),
          node("B", ["A"], {
            runIf: (i) => (i as Record<string, unknown>).A === "A",
          }),
        ],
        exec,
      ),
    );
    expect(manifestById(m).get("B")?.status).toBe("done");
    expect(sawInput).toBe("A");
  });
});

// ─── Cycle detection ─────────────────────────────────────────────────────────

describe("runDag — cycle detection", () => {
  it("throws before any execution on a cycle", async () => {
    const exec = vi.fn(echoExecutor());
    await expect(
      runDag(baseInput([node("A", ["B"]), node("B", ["A"])], exec)),
    ).rejects.toThrow(DagSchedulerError);
    expect(exec).not.toHaveBeenCalled(); // rejected at the start
  });

  it("throws on a self-dependency", async () => {
    await expect(
      runDag(baseInput([node("A", ["A"])], echoExecutor())),
    ).rejects.toThrow(/depends on itself/);
  });

  it("throws on duplicate node ids", async () => {
    await expect(
      runDag(baseInput([node("A"), node("A")], echoExecutor())),
    ).rejects.toThrow(/duplicate node id/);
  });

  it("throws on a missing dependency", async () => {
    await expect(
      runDag(baseInput([node("A", ["ghost"])], echoExecutor())),
    ).rejects.toThrow(/unknown node/);
  });
});

// ─── Partial failure tolerance ───────────────────────────────────────────────

describe("runDag — partial failure tolerance", () => {
  it("one node fails; independent branch still completes; dependent defers", async () => {
    const exec = echoExecutor({
      B: () => ({ status: "failed", output: null, reason: "boom" }),
    });
    // A→B (B fails), B→D (D defers). C is an independent root → done.
    const m = await runDag(
      baseInput(
        [node("A"), node("B", ["A"]), node("D", ["B"]), node("C")],
        exec,
      ),
    );
    const byId = manifestById(m);
    expect(byId.get("A")?.status).toBe("done");
    expect(byId.get("B")?.status).toBe("failed");
    expect(byId.get("D")?.status).toBe("deferred"); // upstream not done
    expect((byId.get("D") as { reason: string }).reason).toMatch(
      /upstream 'B' not done/,
    );
    expect(byId.get("C")?.status).toBe("done"); // independent branch
    expect(m.workflowStatus).toBe("DONE"); // ≥1 done
    expect(m.summary).toEqual({ total: 4, done: 2, deferred: 1, failed: 1 });
  });

  it("workflowStatus FAILED when no node is done", async () => {
    const exec = echoExecutor({
      A: () => ({ status: "failed", output: null, reason: "x" }),
    });
    const m = await runDag(baseInput([node("A"), node("B", ["A"])], exec));
    expect(m.workflowStatus).toBe("FAILED");
    expect(m.summary.done).toBe(0);
  });
});

// ─── Best-of-N ───────────────────────────────────────────────────────────────

describe("runDag — best-of-N", () => {
  it("runs N attempts and picks the verifier-accepted sample", async () => {
    let attempts = 0;
    const exec: NodeExecutor<unknown> = async (_n, _i, ctx) => {
      attempts += 1;
      return { status: "done", output: `sample-${ctx.attempt}` };
    };
    // Verifier accepts the highest-index candidate.
    const verifier: Verifier<unknown> = async (candidates) => {
      const idx = candidates.length - 1;
      return { accepted: candidates[idx], acceptedIndex: idx, reason: "best" };
    };
    const m = await runDag(
      baseInput([node("A", [], { samples: 3 })], exec, { verifier }),
    );
    expect(attempts).toBe(3);
    const a = manifestById(m).get("A");
    expect(a?.status).toBe("done");
    expect(a?.attempts).toBe(3);
    expect(a?.output).toBe("sample-2");
  });

  it("fails closed when the verifier rejects all candidates", async () => {
    const exec = echoExecutor();
    const verifier: Verifier<unknown> = async () => ({
      accepted: null,
      acceptedIndex: -1,
      reason: "all rejected",
    });
    const m = await runDag(
      baseInput([node("A", [], { samples: 2 })], exec, { verifier }),
    );
    const a = manifestById(m).get("A");
    expect(a?.status).toBe("failed");
    expect((a as { reason: string }).reason).toMatch(/rejected all/);
    expect(m.workflowStatus).toBe("FAILED");
  });

  it("throws when a node sets samples>1 but no verifier is provided", async () => {
    await expect(
      runDag(baseInput([node("A", [], { samples: 2 })], echoExecutor())),
    ).rejects.toThrow(/requires a Verifier/);
  });
});

// ─── rootHash determinism + replay-safety ────────────────────────────────────

describe("runDag — rootHash", () => {
  const nodes = [node("A"), node("B", ["A"]), node("C", ["A", "B"])];

  it("is deterministic for the same inputs", async () => {
    const m1 = await runDag(baseInput(nodes, echoExecutor()));
    const m2 = await runDag(baseInput(nodes, echoExecutor()));
    expect(m1.rootHash).toBe(m2.rootHash);
    expect(m1.rootHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of node-array ordering (sorted fingerprints)", async () => {
    const reordered = [nodes[2], nodes[0], nodes[1]];
    const m1 = await runDag(baseInput(nodes, echoExecutor()));
    const m2 = await runDag(baseInput(reordered, echoExecutor()));
    expect(m1.rootHash).toBe(m2.rootHash);
  });

  it("excludes runtime status (success vs failure → same hash)", async () => {
    const okExec = echoExecutor();
    const failExec = echoExecutor({
      A: () => ({ status: "failed", output: null, reason: "x" }),
      B: () => ({ status: "failed", output: null, reason: "x" }),
      C: () => ({ status: "failed", output: null, reason: "x" }),
    });
    const m1 = await runDag(baseInput(nodes, okExec));
    const m2 = await runDag(baseInput(nodes, failExec));
    expect(m1.workflowStatus).toBe("DONE");
    expect(m2.workflowStatus).toBe("FAILED");
    expect(m1.rootHash).toBe(m2.rootHash); // hash is pre-execution governance only
  });

  it("changes when the graph topology changes", async () => {
    const m1 = await runDag(baseInput(nodes, echoExecutor()));
    const m2 = await runDag(
      baseInput(
        [node("A"), node("B", ["A"]), node("C", ["B"])],
        echoExecutor(),
      ),
    );
    expect(m1.rootHash).not.toBe(m2.rootHash);
  });
});

// ─── Guards ──────────────────────────────────────────────────────────────────

describe("runDag — governance guards", () => {
  it("throws when adrEco is missing", async () => {
    await expect(
      runDag(baseInput([node("A")], echoExecutor(), { adrEco: "" })),
    ).rejects.toThrow(/adrEco is mandatory/);
  });

  it("throws on an empty DAG", async () => {
    await expect(runDag(baseInput([], echoExecutor()))).rejects.toThrow(
      /at least one node/,
    );
  });
});

describe("runDag — per-node timeout", () => {
  it("defers a node that exceeds its timeoutMs and aborts its signal; siblings still complete", async () => {
    let abortedSeen = false;
    const executor: NodeExecutor<unknown> = async (node, _inputs, ctx) => {
      if (node.id === "slow") {
        // Never resolves on its own; resolves only if aborted (so the test
        // does not hang) — proves the scheduler both times out AND signals.
        return await new Promise<NodeOutcome<unknown>>((resolve) => {
          ctx.signal?.addEventListener("abort", () => {
            abortedSeen = true;
            resolve({ status: "done", output: "should-be-ignored" });
          });
        });
      }
      return { status: "done", output: `${node.id}:done` };
    };

    const manifest = await runDag(
      baseInput([node("fast"), node("slow", [], { timeoutMs: 20 })], executor),
    );

    const byId = manifestById(manifest);
    expect(byId.get("fast")?.status).toBe("done");
    expect(byId.get("slow")?.status).toBe("deferred");
    expect(byId.get("slow")?.reason).toMatch(/timed out after 20ms/);
    expect(abortedSeen).toBe(true);
    // A deferred node with a completed sibling still yields workflowStatus DONE.
    expect(manifest.workflowStatus).toBe("DONE");
  });

  it("does not arm a timeout when timeoutMs is absent (executor runs to completion)", async () => {
    let sawSignal = false;
    const executor: NodeExecutor<unknown> = async (_node, _inputs, ctx) => {
      sawSignal = ctx.signal !== undefined;
      return { status: "done", output: "ok" };
    };
    const manifest = await runDag(baseInput([node("A")], executor));
    expect(manifestById(manifest).get("A")?.status).toBe("done");
    expect(sawSignal).toBe(false);
  });
});
