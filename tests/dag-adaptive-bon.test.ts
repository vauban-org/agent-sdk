/**
 * tests/dag-adaptive-bon.test.ts
 *
 * Adaptive best-of-N escalation (ST-BoN / adaptive-N cap). Deterministic, no LLM.
 * Covers:
 *   - no policy → full `samples` in one batch (byte-identical to before);
 *   - confident phase-1 winner short-circuits (escalation skipped, losers unborn);
 *   - weak phase-1 winner escalates to the full budget then selects;
 *   - a verifier exposing no acceptedScore can never early-accept;
 *   - fail-closed preserved (all candidates rejected → node failed);
 *   - initialBatch is clamped to [1, samples].
 */

import { describe, it, expect } from "vitest";
import { runDag } from "../src/orchestration/dag/scheduler.js";
import type {
  DagNodeSpec,
  DagRunInput,
  NodeExecutor,
  Verifier,
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
    runId: "run-1",
    adrEco: "ADR-ECO-083",
    ...extra,
  };
}

const node = (id: string, rest: Partial<DagNodeSpec> = {}): DagNodeSpec => ({
  id,
  task: `task ${id}`,
  ...rest,
});

/** Executor that counts attempts and tags each output by attempt index. */
function countingExecutor(): {
  exec: NodeExecutor<unknown>;
  count: () => number;
} {
  let n = 0;
  const exec: NodeExecutor<unknown> = async (_node, _inputs, ctx) => {
    n += 1;
    return { status: "done", output: `sample-${ctx.attempt}` };
  };
  return { exec, count: () => n };
}

/** Verifier: accepts index 0 with a fixed score (drives early-accept gating). */
function scoringVerifier(score: number): Verifier<unknown> {
  return async (candidates) => ({
    accepted: candidates[0],
    acceptedIndex: 0,
    reason: `score ${score}`,
    acceptedScore: score,
  });
}

describe("adaptive best-of-N", () => {
  it("no policy → full samples in one batch (byte-identical)", async () => {
    const { exec, count } = countingExecutor();
    const m = await runDag(
      baseInput([node("A", { samples: 4 })], exec, {
        verifier: scoringVerifier(0.9),
      }),
    );
    expect(count()).toBe(4); // full budget, no escalation logic
    const a = m.nodes.find((x) => x.id === "A");
    expect(a?.status).toBe("done");
    expect(a?.attempts).toBe(4);
  });

  it("confident phase-1 winner short-circuits (losers never spawned)", async () => {
    const { exec, count } = countingExecutor();
    const m = await runDag(
      baseInput([node("A", { samples: 6 })], exec, {
        verifier: scoringVerifier(0.95), // ≥ default 0.85 bar
        bestOfN: { initialBatch: 2, earlyAcceptThreshold: 0.85 },
      }),
    );
    expect(count()).toBe(2); // escalation skipped → only the initial batch ran
    const a = m.nodes.find((x) => x.id === "A");
    expect(a?.status).toBe("done");
    expect(a?.attempts).toBe(2);
  });

  it("weak phase-1 winner escalates to the full budget", async () => {
    const { exec, count } = countingExecutor();
    const m = await runDag(
      baseInput([node("A", { samples: 6 })], exec, {
        verifier: scoringVerifier(0.4), // < bar → must escalate
        bestOfN: { initialBatch: 2, earlyAcceptThreshold: 0.85 },
      }),
    );
    expect(count()).toBe(6); // escalated to full samples
    const a = m.nodes.find((x) => x.id === "A");
    expect(a?.status).toBe("done");
    expect(a?.attempts).toBe(6);
  });

  it("a verifier exposing no acceptedScore never early-accepts", async () => {
    const { exec, count } = countingExecutor();
    const noScore: Verifier<unknown> = async (candidates) => ({
      accepted: candidates[0],
      acceptedIndex: 0,
      reason: "no score",
    });
    const m = await runDag(
      baseInput([node("A", { samples: 5 })], exec, {
        verifier: noScore,
        bestOfN: { initialBatch: 2 },
      }),
    );
    expect(count()).toBe(5); // can't short-circuit without a score → full budget
    expect(m.nodes.find((x) => x.id === "A")?.status).toBe("done");
  });

  it("fail-closed preserved under escalation when all candidates are rejected", async () => {
    const { exec } = countingExecutor();
    const rejectAll: Verifier<unknown> = async () => ({
      accepted: null,
      acceptedIndex: -1,
      reason: "all rejected",
    });
    const m = await runDag(
      baseInput([node("A", { samples: 4 })], exec, {
        verifier: rejectAll,
        bestOfN: { initialBatch: 2 },
      }),
    );
    const a = m.nodes.find((x) => x.id === "A");
    expect(a?.status).toBe("failed");
    expect((a as { reason: string }).reason).toMatch(/rejected all/);
  });

  it("clamps initialBatch above samples down to samples (one batch)", async () => {
    const { exec, count } = countingExecutor();
    const m = await runDag(
      baseInput([node("A", { samples: 3 })], exec, {
        verifier: scoringVerifier(0.1), // low, but no phase 2 possible (clamped)
        bestOfN: { initialBatch: 99 },
      }),
    );
    expect(count()).toBe(3); // initialBatch clamped to samples → single batch
    expect(m.nodes.find((x) => x.id === "A")?.attempts).toBe(3);
  });
});
