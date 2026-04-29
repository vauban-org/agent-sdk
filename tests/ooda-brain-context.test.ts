/**
 * `withBrainContext` ORIENT-phase wrapper tests — sprint-525:quick-4.
 *
 * Coverage:
 *   - disabled → orient receives empty context, no step row inserted
 *   - enabled  → calls fetchBrainContext, injects chunks + refs
 *   - mcp_call_hash + retrieval_proof_hash propagated to completeStep payload
 *   - replay mode → uses replayChunks, no fetch call
 *   - missing fetchBrainContext + enabled → BrainSkillNotConfiguredError
 *   - minSimilarity threshold filters chunks below
 *   - dedup preserves first-seen order across duplicate entry_ids
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainSkillNotConfiguredError,
  withBrainContext,
  type BrainCallResult,
  type BrainChunk,
  type OrientInputWithBrain,
} from "../src/orchestration/ooda/brain-context.js";
import type { OODAContext } from "../src/orchestration/ooda/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface ObsInput {
  readonly query: string;
}

interface OrientOutput {
  readonly count: number;
  readonly refs: string[];
}

const CHUNK_A: BrainChunk = {
  entry_id: "a",
  content: "alpha",
  similarity: 0.95,
};
const CHUNK_B: BrainChunk = {
  entry_id: "b",
  content: "beta",
  similarity: 0.85,
};
const CHUNK_C: BrainChunk = {
  entry_id: "c",
  content: "gamma",
  similarity: 0.55, // below default 0.7 threshold
};

function makeCtx(opts: { isReplay?: boolean } = {}): {
  ctx: OODAContext;
  insertStep: ReturnType<typeof vi.fn>;
  completeStep: ReturnType<typeof vi.fn>;
  errorStep: ReturnType<typeof vi.fn>;
} {
  const insertStep = vi
    .fn()
    .mockResolvedValue({ stepId: "step-001" });
  const completeStep = vi
    .fn()
    .mockResolvedValue({ leafHash: "0xabc" });
  const errorStep = vi.fn().mockResolvedValue(undefined);

  const ctx: OODAContext = {
    agentId: "TEST",
    runId: "run-1",
    cycleIndex: 0,
    executionMode: "live",
    isReplay: opts.isReplay ?? false,
    config: {},
    db: { query: vi.fn() } as unknown as OODAContext["db"],
    skills: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as OODAContext["logger"],
    insertStep,
    completeStep,
    errorStep,
    notifySlack: vi.fn().mockResolvedValue(undefined),
  };

  return { ctx, insertStep, completeStep, errorStep };
}

function fetcherReturning(
  result: BrainChunk[],
  hashes = { mcp_call_hash: "MCP-1", retrieval_proof_hash: "RET-1" },
) {
  const fetcher = vi.fn(
    async (_q: string, _k: number): Promise<BrainCallResult<BrainChunk[]>> => ({
      result,
      mcp_call_hash: hashes.mcp_call_hash,
      retrieval_proof_hash: hashes.retrieval_proof_hash,
    }),
  );
  return fetcher;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("withBrainContext", () => {
  let orientFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    orientFn = vi.fn(
      async (
        input: OrientInputWithBrain<ObsInput>,
      ): Promise<OrientOutput> => ({
        count: input.brainContext.length,
        refs: input.brainContextRefs,
      }),
    );
  });

  it("disabled → orient receives empty brain context, no step inserted", async () => {
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: false,
        query: (i) => i.query,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx, insertStep, completeStep } = makeCtx();
    const out = await wrapped({ query: "hello" }, ctx);

    expect(out).toEqual({ count: 0, refs: [] });
    expect(insertStep).not.toHaveBeenCalled();
    expect(completeStep).not.toHaveBeenCalled();
    expect(orientFn).toHaveBeenCalledWith(
      { raw: { query: "hello" }, brainContext: [], brainContextRefs: [] },
      ctx,
    );
  });

  it("enabled → fetcher called, chunks injected, refs populated", async () => {
    const fetcher = fetcherReturning([CHUNK_A, CHUNK_B]);
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ query: "search" }, ctx);

    expect(fetcher).toHaveBeenCalledWith("search", 5);
    expect(out.count).toBe(2);
    expect(out.refs).toEqual(["a", "b"]);
  });

  it("propagates mcp_call_hash + retrieval_proof_hash to completeStep payload", async () => {
    const fetcher = fetcherReturning([CHUNK_A], {
      mcp_call_hash: "HASH-CALL-XYZ",
      retrieval_proof_hash: "HASH-PROOF-XYZ",
    });
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx, insertStep, completeStep } = makeCtx();
    await wrapped({ query: "q" }, ctx);

    expect(insertStep).toHaveBeenCalledTimes(1);
    expect(insertStep).toHaveBeenCalledWith({
      type: "retrieval",
      phase: "orient.brain-context",
      payload: { query: "q", topK: 5, minSimilarity: 0.7 },
    });

    expect(completeStep).toHaveBeenCalledTimes(1);
    const [stepId, payload] = completeStep.mock.calls[0]!;
    expect(stepId).toBe("step-001");
    expect(payload).toMatchObject({
      query: "q",
      brain_entry_ids: ["a"],
      mcp_call_hash: "HASH-CALL-XYZ",
      retrieval_proof_hash: "HASH-PROOF-XYZ",
      chunk_count: 1,
    });
  });

  it("missing fetchBrainContext + enabled → BrainSkillNotConfiguredError", async () => {
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        // no fetchBrainContext
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx, errorStep } = makeCtx();

    await expect(wrapped({ query: "x" }, ctx)).rejects.toBeInstanceOf(
      BrainSkillNotConfiguredError,
    );
    expect(errorStep).toHaveBeenCalledTimes(1);
    expect(orientFn).not.toHaveBeenCalled();
  });

  it("minSimilarity threshold filters chunks below", async () => {
    const fetcher = fetcherReturning([CHUNK_A, CHUNK_B, CHUNK_C]);
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher,
        minSimilarity: 0.7,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ query: "q" }, ctx);

    // CHUNK_C similarity = 0.55 < 0.7 → filtered.
    expect(out.refs).toEqual(["a", "b"]);
    expect(out.count).toBe(2);
  });

  it("topK truncates after sorting by descending similarity", async () => {
    const fetcher = fetcherReturning([
      { entry_id: "low", content: "", similarity: 0.71 },
      { entry_id: "high", content: "", similarity: 0.99 },
      { entry_id: "mid", content: "", similarity: 0.85 },
    ]);
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher,
        topK: 2,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ query: "q" }, ctx);

    expect(out.refs).toEqual(["high", "mid"]);
  });

  it("dedup preserves first-seen order on duplicate entry_ids", async () => {
    const fetcher = fetcherReturning([
      { entry_id: "x", content: "", similarity: 0.95 },
      { entry_id: "y", content: "", similarity: 0.9 },
      { entry_id: "x", content: "", similarity: 0.85 },
    ]);
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher,
        topK: 10,
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ query: "q" }, ctx);

    expect(out.refs).toEqual(["x", "y"]);
  });

  it("replay mode → uses replayChunks, no fetcher call", async () => {
    const fetcher = vi.fn();
    const wrapped = withBrainContext<ObsInput, OrientOutput>(
      {
        enabled: true,
        query: (i) => i.query,
        fetchBrainContext: fetcher as unknown as (
          q: string,
          k: number,
        ) => Promise<BrainCallResult<BrainChunk[]>>,
        replayChunks: [CHUNK_A, CHUNK_B],
      },
      orientFn as unknown as (
        input: OrientInputWithBrain<ObsInput>,
        ctx: OODAContext,
      ) => Promise<OrientOutput>,
    );
    const { ctx, completeStep } = makeCtx({ isReplay: true });
    const out = await wrapped({ query: "q" }, ctx);

    expect(fetcher).not.toHaveBeenCalled();
    expect(out.refs).toEqual(["a", "b"]);
    // hashes are null in replay (no MCP call performed).
    const [, payload] = completeStep.mock.calls[0]!;
    expect(payload).toMatchObject({
      mcp_call_hash: null,
      retrieval_proof_hash: null,
    });
  });
});
