/**
 * Built-in recall activation tests for `withBrainContext` — sprint-805 Task 2.
 *
 * ADR-ECO-065: the built-in `brainRecall` default fetcher is activated when:
 *   (a) `options.builtinRecall === true`, OR
 *   (b) env var `BRAIN_AGENTIC_RECALL=true`
 * and `fetchBrainContext` is absent.
 *
 * Backward-compat guarantee: when NEITHER flag is set AND fetchBrainContext is
 * absent, `BrainSkillNotConfiguredError` is still thrown (no regression).
 *
 * Cache-safety invariant (Brain a8e8423a / arXiv:2601.06007):
 *   Built-in recall chunks flow only into the dynamic orient brainContext zone.
 *   They MUST NOT be placed in any cacheable prefix. The built-in path uses
 *   renderMemoryContext for the hash input only; the chunks themselves are
 *   injected as OrientInputWithBrain.brainContext (per-turn dynamic).
 *
 * Coverage:
 *   1. builtinRecall=true → built-in fetcher used, chunks injected
 *   2. BRAIN_AGENTIC_RECALL=true env → built-in fetcher used, chunks injected
 *   3. Neither flag → BrainSkillNotConfiguredError (backward-compat)
 *   4. fetchBrainContext present + builtinRecall=true → explicit fetcher wins
 *   5. Built-in fetcher degraded path → empty context, degraded payload in completeStep
 *   6. Built-in chunks flow to dynamic brainContext only (not cacheable prefix)
 *   7. builtinRecall=false + no env → BrainSkillNotConfiguredError (explicit false)
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrainCallResult,
  type BrainChunk,
  BrainSkillNotConfiguredError,
  type OrientInputWithBrain,
  withBrainContext,
} from "../src/orchestration/ooda/brain-context.js";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import * as brainRecallMod from "../src/recall/brain-recall.js";
import type { RecallResult } from "../src/recall/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface ObsInput {
  readonly q: string;
}
interface OrientOut {
  readonly count: number;
  readonly refs: string[];
}

function makeCtx(opts: { isReplay?: boolean } = {}): {
  ctx: OODAContext;
  insertStep: ReturnType<typeof vi.fn>;
  completeStep: ReturnType<typeof vi.fn>;
  errorStep: ReturnType<typeof vi.fn>;
} {
  const insertStep = vi.fn().mockResolvedValue({ stepId: "step-001" });
  const completeStep = vi.fn().mockResolvedValue({ leafHash: "0xdeadbeef" });
  const errorStep = vi.fn().mockResolvedValue(undefined);

  const ctx: OODAContext = {
    agentId: "TEST-BUILTIN",
    runId: "run-builtin-1",
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

function orientFn(input: OrientInputWithBrain<ObsInput>): Promise<OrientOut> {
  return Promise.resolve({
    count: input.brainContext.length,
    refs: input.brainContextRefs,
  });
}

const RECALL_CHUNK_A = {
  id: "rc-001",
  content: "Paris is the capital of France",
  hybrid_score: 0.88,
  cross_encoder_score: 0.93,
  similarity: 0.8,
  category: "fact",
  tags: ["geography"],
  created_at: "2026-01-01T00:00:00Z",
  brain_id: null,
  brain_slug: null,
};

const RECALL_CHUNK_B = {
  id: "rc-002",
  content: "Berlin is the capital of Germany",
  hybrid_score: 0.75,
  cross_encoder_score: null,
  similarity: 0.72,
  category: "fact",
  tags: ["geography"],
  created_at: "2026-01-01T00:00:00Z",
  brain_id: null,
  brain_slug: null,
};

function makeRecallResult(
  chunks = [RECALL_CHUNK_A, RECALL_CHUNK_B],
  strategy = "direct",
): RecallResult {
  return {
    chunks,
    answer: null,
    strategy_used: strategy,
    hops_used: 1,
    refs: chunks.map((c) => c.id),
    freshness: [],
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let brainRecallSpy: MockInstance;

beforeEach(() => {
  // Always mock the brainRecall function from the SDK recall module.
  brainRecallSpy = vi.spyOn(brainRecallMod, "brainRecall").mockResolvedValue(makeRecallResult());

  // Ensure env vars start clean.
  delete process.env.BRAIN_AGENTIC_RECALL;
  process.env.BRAIN_URL = "https://brain.test";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BRAIN_AGENTIC_RECALL;
  delete process.env.BRAIN_URL;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("withBrainContext — built-in recall activation (ADR-ECO-065)", () => {
  // 1. builtinRecall=true → brainRecall() called, BrainChunks injected into orient
  it("builtinRecall=true activates built-in fetcher and injects chunks", async () => {
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        builtinRecall: true,
      },
      orientFn,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ q: "capitals of Europe" }, ctx);

    expect(brainRecallSpy).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(2);
    expect(out.refs).toEqual(["rc-001", "rc-002"]);
  });

  // 2. BRAIN_AGENTIC_RECALL=true env → same behaviour
  it("BRAIN_AGENTIC_RECALL=true env activates built-in fetcher", async () => {
    process.env.BRAIN_AGENTIC_RECALL = "true";
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        // no builtinRecall flag, no fetchBrainContext
      },
      orientFn,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ q: "test query" }, ctx);

    expect(brainRecallSpy).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(2);
  });

  // 3. Neither flag → BrainSkillNotConfiguredError (backward-compat)
  it("neither builtinRecall flag nor BRAIN_AGENTIC_RECALL env → throws BrainSkillNotConfiguredError", async () => {
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        // no fetchBrainContext, no builtinRecall, no env var
      },
      orientFn,
    );
    const { ctx } = makeCtx();

    await expect(wrapped({ q: "x" }, ctx)).rejects.toBeInstanceOf(BrainSkillNotConfiguredError);
    expect(brainRecallSpy).not.toHaveBeenCalled();
  });

  // 4. explicit fetchBrainContext wins over builtinRecall=true
  it("explicit fetchBrainContext takes precedence over builtinRecall=true", async () => {
    const explicitChunk: BrainChunk = {
      entry_id: "explicit-001",
      content: "explicit chunk",
      similarity: 0.9,
    };
    const explicitFetcher = vi.fn(
      async (): Promise<BrainCallResult<BrainChunk[]>> => ({
        result: [explicitChunk],
        mcp_call_hash: "explicit-hash",
        retrieval_proof_hash: "explicit-ret-hash",
      }),
    );
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        builtinRecall: true,
        fetchBrainContext: explicitFetcher,
      },
      orientFn,
    );
    const { ctx } = makeCtx();
    const out = await wrapped({ q: "test" }, ctx);

    expect(explicitFetcher).toHaveBeenCalledTimes(1);
    expect(brainRecallSpy).not.toHaveBeenCalled();
    expect(out.refs).toEqual(["explicit-001"]);
  });

  // 5. built-in fetcher degraded path → empty context, degraded flag in completeStep
  it("built-in recall degraded path → empty brainContext, degraded=true in step payload", async () => {
    brainRecallSpy.mockResolvedValue(makeRecallResult([], "degraded"));
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        builtinRecall: true,
      },
      orientFn,
    );
    const { ctx, completeStep } = makeCtx();
    const out = await wrapped({ q: "degraded query" }, ctx);

    expect(out.count).toBe(0);
    expect(out.refs).toEqual([]);
    const [, payload] = completeStep.mock.calls[0]!;
    expect(payload).toMatchObject({
      degraded: true,
      fallback: "UNGROUNDED",
    });
  });

  // 6. cache-safety: built-in chunks go to dynamic brainContext, NOT a cacheable string prefix
  it("built-in recall chunks are in brainContext (dynamic zone), never in cacheable text", async () => {
    let capturedInput: OrientInputWithBrain<ObsInput> | null = null;
    const capturingOrient = async (input: OrientInputWithBrain<ObsInput>): Promise<OrientOut> => {
      capturedInput = input;
      return { count: input.brainContext.length, refs: input.brainContextRefs };
    };

    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        builtinRecall: true,
      },
      capturingOrient,
    );
    const { ctx } = makeCtx();
    await wrapped({ q: "cache-safety test" }, ctx);

    // Chunks are in the structured brainContext (dynamic zone), not a plain string
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.brainContext).toHaveLength(2);
    expect(capturedInput!.brainContext[0]).toMatchObject({
      entry_id: "rc-001",
      content: "Paris is the capital of France",
    });
    // The raw observe input is also available (not replaced by a string)
    expect(capturedInput!.raw).toEqual({ q: "cache-safety test" });
  });

  // 7. builtinRecall=false (explicit) + no env → same as missing flag → BrainSkillNotConfiguredError
  it("builtinRecall=false + no env → throws BrainSkillNotConfiguredError", async () => {
    const wrapped = withBrainContext<ObsInput, OrientOut>(
      {
        enabled: true,
        query: (i) => i.q,
        builtinRecall: false,
        // no fetchBrainContext
      },
      orientFn,
    );
    const { ctx } = makeCtx();

    await expect(wrapped({ q: "x" }, ctx)).rejects.toBeInstanceOf(BrainSkillNotConfiguredError);
    expect(brainRecallSpy).not.toHaveBeenCalled();
  });
});
