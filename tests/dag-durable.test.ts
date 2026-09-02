/**
 * dag-durable.test.ts — Wave 2: optional node-level durability (crash-resume).
 *
 * Uses a fake in-memory StepJournal + fake executors (no real LLM, no I/O):
 *  - a first run records each terminal node into the journal
 *  - a SECOND runDag over the SAME journal with an executor that THROWS if
 *    called proves that already-`done` nodes are skipped (resumed), while
 *    non-done nodes DO re-execute
 *  - no-journal runs are byte-identical to today (behaviour unchanged)
 *  - record is idempotent (recording twice is safe)
 *  - a throwing journal surfaces (does not silently continue)
 *  - rootHash is unaffected by journal presence/state (determinism)
 */

import { describe, it, expect } from "vitest";
import { runDag } from "../src/orchestration/dag/scheduler.js";
import type {
  DagNodeSpec,
  NodeExecutor,
  NodeInputs,
  NodeManifestEntry,
  NodeOutcome,
  StepJournal,
} from "../src/orchestration/dag/contracts.js";

const clock = { now: () => 0 };

function node(
  id: string,
  deps: string[] = [],
  rest: Partial<DagNodeSpec> = {},
): DagNodeSpec {
  return { id, task: `task ${id}`, dependsOn: deps, ...rest };
}

/** A simple in-memory StepJournal keyed by `${runId}::${nodeId}`. */
class FakeJournal<T = unknown> implements StepJournal<T> {
  readonly store = new Map<string, NodeManifestEntry<T>>();
  recordCalls = 0;
  recallCalls = 0;
  private key(runId: string, nodeId: string) {
    return `${runId}::${nodeId}`;
  }
  async recall(runId: string, nodeId: string) {
    this.recallCalls += 1;
    return this.store.get(this.key(runId, nodeId));
  }
  async record(runId: string, entry: NodeManifestEntry<T>) {
    this.recordCalls += 1;
    this.store.set(this.key(runId, entry.id), entry); // idempotent upsert
  }
}

function echoExecutor(
  overrides: Record<
    string,
    (inputs: NodeInputs, attempt: number) => NodeOutcome<unknown>
  > = {},
): NodeExecutor<unknown> {
  return async (n, inputs, ctx) => {
    const o = overrides[n.id];
    if (o) return o(inputs, ctx.attempt);
    return { status: "done", output: `${n.id}:done` };
  };
}

describe("runDag durability (Wave 2)", () => {
  it("records every terminal node into the journal on a first run", async () => {
    const journal = new FakeJournal();
    const m = await runDag({
      nodes: [node("a"), node("b", ["a"])],
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });

    expect(m.workflowStatus).toBe("DONE");
    expect(journal.store.get("run-1::a")?.status).toBe("done");
    expect(journal.store.get("run-1::b")?.status).toBe("done");
    expect(journal.store.get("run-1::a")?.output).toBe("a:done");
  });

  it("resumes: a SECOND run skips already-done nodes (executor never called for them)", async () => {
    const journal = new FakeJournal();

    // First run: a + b succeed and are recorded.
    await runDag({
      nodes: [node("a"), node("b", ["a"]), node("c", ["b"])],
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });

    // Simulate a crash that wiped only c's record: a and b are done, c is not.
    journal.store.delete("run-1::c");

    // Second run: the executor THROWS if called for an already-done node.
    let cRan = false;
    const resumeExecutor: NodeExecutor<unknown> = async (n, inputs) => {
      if (n.id === "a" || n.id === "b") {
        throw new Error(`node ${n.id} must NOT re-execute on resume`);
      }
      cRan = true;
      // c sees b's recalled output threaded as input.
      expect(inputs.b).toBe("b:done");
      return { status: "done", output: "c:done" };
    };

    const m2 = await runDag({
      nodes: [node("a"), node("b", ["a"]), node("c", ["b"])],
      executor: resumeExecutor,
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });

    expect(cRan).toBe(true);
    expect(m2.workflowStatus).toBe("DONE");
    const c = m2.nodes.find((x) => x.id === "c");
    expect(c?.status).toBe("done");
    expect(c?.output).toBe("c:done");
  });

  it("done-only short-circuit: a recalled FAILED node re-executes on resume", async () => {
    const journal = new FakeJournal();

    // First run: b fails.
    await runDag({
      nodes: [node("a"), node("b", ["a"])],
      executor: echoExecutor({
        b: () => ({ status: "failed", output: null, reason: "boom" }),
      }),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });
    expect(journal.store.get("run-1::b")?.status).toBe("failed");

    // Second run: b now succeeds; the failed recall must NOT short-circuit.
    let bRan = false;
    const m2 = await runDag({
      nodes: [node("a"), node("b", ["a"])],
      executor: async (n) => {
        if (n.id === "a")
          throw new Error("a must not re-execute (it was done)");
        bRan = true;
        return { status: "done", output: "b:fixed" };
      },
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });

    expect(bRan).toBe(true);
    expect(m2.nodes.find((x) => x.id === "b")?.status).toBe("done");
    expect(journal.store.get("run-1::b")?.status).toBe("done");
  });

  it("no-journal path is unchanged (executor always runs every node)", async () => {
    let runs = 0;
    const m = await runDag({
      nodes: [node("a"), node("b", ["a"])],
      executor: async (n) => {
        runs += 1;
        return { status: "done", output: `${n.id}:done` };
      },
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
    });
    expect(runs).toBe(2);
    expect(m.workflowStatus).toBe("DONE");
  });

  it("record is idempotent: re-running over a full journal records done again safely", async () => {
    const journal = new FakeJournal();
    const nodes = [node("a"), node("b", ["a"])];
    const first = await runDag({
      nodes,
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });
    const recordsAfterFirst = journal.recordCalls;

    // Re-run with a throwing executor: every node is recalled done, none runs,
    // and nothing is re-recorded (resume returns before record).
    const second = await runDag({
      nodes,
      executor: async (n) => {
        throw new Error(`${n.id} must not run`);
      },
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal,
    });

    expect(second.workflowStatus).toBe("DONE");
    expect(journal.store.size).toBe(2); // no duplicates (keyed upsert)
    // No new records on a full-resume run (all short-circuited).
    expect(journal.recordCalls).toBe(recordsAfterFirst);
    expect(second.summary.done).toBe(first.summary.done);
  });

  it("a throwing journal SURFACES (node fails, run not silently corrupted)", async () => {
    const badJournal: StepJournal = {
      recall: async () => {
        throw new Error("journal recall I/O error");
      },
      record: async () => {},
    };

    const m = await runDag({
      nodes: [node("a")],
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal: badJournal,
    });

    // The journal error is not swallowed: the node is marked failed with the
    // journal error reason (surfaced via execute()'s defensive catch).
    expect(m.workflowStatus).toBe("FAILED");
    expect(m.nodes[0]?.status).toBe("failed");
    expect(m.nodes[0]?.reason).toContain("journal recall I/O error");
  });

  it("rootHash is identical with and without a journal (determinism)", async () => {
    const nodes = [node("a"), node("b", ["a"])];
    const withoutJournal = await runDag({
      nodes,
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
    });
    const withJournal = await runDag({
      nodes,
      executor: echoExecutor(),
      clock,
      runId: "run-1",
      adrEco: "ADR-ECO-083",
      journal: new FakeJournal(),
    });
    expect(withJournal.rootHash).toBe(withoutJournal.rootHash);
  });
});
