/**
 * `withBrainContext` WM + EM plane folding — sprint-895, ADR-ECO-114.
 *
 * Coverage:
 *   - loads WM goal + EM window when both planes present; folds into
 *     workingMemoryGoal / episodicWindow / renderedMemoryContext ALONGSIDE
 *     the semantic recall chunks.
 *   - feature-detects each plane INDEPENDENTLY (working-only, episodic-only).
 *   - semantic-only host (no `memory`) → orient receives the exact
 *     { raw, brainContext, brainContextRefs } shape, no plane fields, no throw.
 *   - disabled semantic recall + memory present → WM/EM still load.
 *   - a plane read that throws degrades to empty, never aborts orient.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrainCallResult,
  type BrainChunk,
  type OrientInputWithBrain,
  withBrainContext,
} from "../src/orchestration/ooda/brain-context.js";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import {
  type BrainPort,
  InMemoryEpisodicMemory,
  InMemoryWorkingMemory,
} from "../src/ports/brain.js";

interface ObsInput {
  readonly query: string;
}

const CHUNK_A: BrainChunk = { entry_id: "a", content: "alpha", similarity: 0.95 };

function makeCtx(opts: { agentId?: string; runId?: string } = {}): OODAContext {
  return {
    agentId: opts.agentId ?? "TEST-AGENT",
    runId: opts.runId ?? "run-1",
    cycleIndex: 0,
    executionMode: "live",
    isReplay: false,
    config: {},
    db: { query: vi.fn() } as unknown as OODAContext["db"],
    skills: {} as OODAContext["skills"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as OODAContext["logger"],
    insertStep: vi.fn().mockResolvedValue({ stepId: "step-001" }),
    completeStep: vi.fn().mockResolvedValue({ leafHash: "0xabc" }),
    errorStep: vi.fn().mockResolvedValue(undefined),
    notifySlack: vi.fn().mockResolvedValue(undefined),
  } as unknown as OODAContext;
}

function fetcherReturning(result: BrainChunk[]) {
  return vi.fn(
    async (_q: string, _k: number): Promise<BrainCallResult<BrainChunk[]>> => ({
      result,
      mcp_call_hash: "MCP-1",
      retrieval_proof_hash: "RET-1",
    }),
  );
}

/** orientFn that echoes the augmented input so tests can assert on it. */
function echoOrient() {
  return vi.fn(
    async (input: OrientInputWithBrain<ObsInput>): Promise<OrientInputWithBrain<ObsInput>> => input,
  ) as unknown as (
    input: OrientInputWithBrain<ObsInput>,
    ctx: OODAContext,
  ) => Promise<OrientInputWithBrain<ObsInput>>;
}

describe("withBrainContext — WM + EM planes", () => {
  let working: InMemoryWorkingMemory;
  let episodic: InMemoryEpisodicMemory;

  beforeEach(async () => {
    working = new InMemoryWorkingMemory();
    episodic = new InMemoryEpisodicMemory();
    await working.set("run-1", "goal", { objective: "ship it" }, { importanceScore: 0.9 });
    await episodic.append(
      "TEST-AGENT",
      "run-1",
      "observation",
      { note: "prior obs" },
      {
        importanceScore: 0.4,
      },
    );
  });

  it("loads WM goal + EM window and folds them alongside semantic chunks", async () => {
    const memory: Pick<BrainPort, "working" | "episodic"> = { working, episodic };
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcherReturning([CHUNK_A]),
        memory,
      },
      echoOrient(),
    );
    const out = await wrapped({ query: "q" }, makeCtx());

    expect(out.workingMemoryGoal?.slotId).toBe("goal");
    expect(out.workingMemoryGoal?.content).toEqual({ objective: "ship it" });
    expect(out.episodicWindow).toHaveLength(1);
    expect(out.episodicWindow?.[0]?.eventType).toBe("observation");
    // Semantic recall preserved alongside the planes.
    expect(out.brainContextRefs).toEqual(["a"]);
    // Folded context carries all three sub-sections.
    expect(out.renderedMemoryContext).toContain("<working_memory>");
    expect(out.renderedMemoryContext).toContain("ship it");
    expect(out.renderedMemoryContext).toContain("<episodic_window>");
    expect(out.renderedMemoryContext).toContain("prior obs");
    expect(out.renderedMemoryContext).toContain("<semantic_recall>");
    expect(out.renderedMemoryContext).toContain('id="a"');
  });

  it("feature-detects working-only (no episodic) without throwing", async () => {
    const memory: Pick<BrainPort, "working" | "episodic"> = { working };
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      { enabled: true, query: (i) => i.query, fetchBrainContext: fetcherReturning([]), memory },
      echoOrient(),
    );
    const out = await wrapped({ query: "q" }, makeCtx());
    expect(out.workingMemoryGoal?.slotId).toBe("goal");
    expect(out.episodicWindow).toEqual([]);
  });

  it("feature-detects episodic-only (no working) without throwing", async () => {
    const memory: Pick<BrainPort, "working" | "episodic"> = { episodic };
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      { enabled: true, query: (i) => i.query, fetchBrainContext: fetcherReturning([]), memory },
      echoOrient(),
    );
    const out = await wrapped({ query: "q" }, makeCtx());
    expect(out.workingMemoryGoal).toBeNull();
    expect(out.episodicWindow).toHaveLength(1);
  });

  it("semantic-only host (no memory) receives NO plane fields and does not throw", async () => {
    const orientFn = echoOrient();
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      { enabled: true, query: (i) => i.query, fetchBrainContext: fetcherReturning([CHUNK_A]) },
      orientFn,
    );
    const out = await wrapped({ query: "q" }, makeCtx());
    // Exact shape — plane fields absent (undefined), semantic recall intact.
    expect(out.workingMemoryGoal).toBeUndefined();
    expect(out.episodicWindow).toBeUndefined();
    expect(out.renderedMemoryContext).toBeUndefined();
    expect(out.brainContextRefs).toEqual(["a"]);
  });

  it("disabled semantic recall + memory present → WM/EM still load", async () => {
    const memory: Pick<BrainPort, "working" | "episodic"> = { working, episodic };
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      { enabled: false, query: (i) => i.query, memory },
      echoOrient(),
    );
    const out = await wrapped({ query: "q" }, makeCtx());
    expect(out.brainContext).toEqual([]);
    expect(out.workingMemoryGoal?.slotId).toBe("goal");
    expect(out.episodicWindow).toHaveLength(1);
  });

  it("a plane read that throws degrades to empty and never aborts orient", async () => {
    const brokenWorking = new InMemoryWorkingMemory();
    vi.spyOn(brokenWorking, "list").mockRejectedValueOnce(new Error("WM down"));
    const memory: Pick<BrainPort, "working" | "episodic"> = { working: brokenWorking, episodic };
    const wrapped = withBrainContext<ObsInput, OrientInputWithBrain<ObsInput>>(
      { enabled: true, query: (i) => i.query, fetchBrainContext: fetcherReturning([]), memory },
      echoOrient(),
    );
    const out = await wrapped({ query: "q" }, makeCtx());
    expect(out.workingMemoryGoal).toBeNull();
    expect(out.episodicWindow).toHaveLength(1);
  });
});
