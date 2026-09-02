/**
 * Tests for cross-cycle replay propagation.
 *
 * Coverage:
 *   1. 5-cycle chain (root → c1 → c2 → c3 → c4): all replay byte-identical.
 *   2. Child cycle replayed alone (with parentCtx): matches original rootHash.
 *   3. Chain with broken parentRunId → MissingParentRunError.
 *   4. clone() invariant: RecordedClock and RecordedRandom clones consume in
 *      lockstep with the original at the split point.
 *   5. CompositeLLMResponseCache / withParent: lookup-through + write-back disabled.
 */

import { describe, expect, it } from "vitest";
import { ClockExhaustedError, RecordedClock } from "../src/replay/clock.js";
import {
  MissingParentRunError,
  propagateContext,
  replayChain,
  replayFromWithParent,
} from "../src/replay/cross-cycle.js";
import type { ChainReplayResult, ChainedReplayContext } from "../src/replay/cross-cycle.js";
import {
  CompositeLLMResponseCache,
  InMemoryLLMResponseCache,
  withParent,
} from "../src/replay/llm-cache.js";
import { RecordedRandom } from "../src/replay/random.js";
import type { ReplayLoader, ReplayResult, ReplayRunner } from "../src/replay/replay.js";
import type { Trace, TraceStep } from "../src/trace/schema.js";
import { TRACE_SCHEMA_VERSION } from "../src/trace/schema.js";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/** Build a minimal valid TraceStep. */
function makeStep(index: number, runId: string, ts: number): TraceStep {
  const prevStepHash = index === 0 ? "0".repeat(64) : `hash-step-${index - 1}`;
  return {
    index,
    runId,
    phase: "decide",
    type: "llm_call",
    timestamp: ts,
    durationMs: 1,
    inputHash: `ihash-${index}`,
    outputHash: `ohash-${index}`,
    policy: "hash-only",
    prevStepHash,
    stepHash: `hash-step-${index}`,
  };
}

/** Build a minimal valid Trace with a deterministic rootHash derived from runId + step hashes. */
function makeTrace(runId: string, startTs: number, stepCount: number): Trace {
  const steps: TraceStep[] = [];
  for (let i = 0; i < stepCount; i++) {
    steps.push(makeStep(i, runId, startTs + i * 10));
  }
  const rootHash = `root-${runId}-${steps.map((s) => s.stepHash).join("-")}`;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId,
    agentId: "test-agent",
    agentVersion: "0.0.1",
    startedAt: startTs,
    completedAt: startTs + stepCount * 10,
    status: "completed",
    steps,
    totalSteps: stepCount,
    rootHash,
    config: {},
    configHash: "cfg-hash",
  };
}

/**
 * Deterministic runner: returns the original trace unchanged (simulates
 * byte-identical replay where all deps are virtualized).
 * The runner ignores ctx — it just returns the originalTrace directly.
 * This is the "perfect replay" case.
 */
const identityRunner: ReplayRunner = {
  async run(_ctx, originalTrace) {
    return originalTrace;
  },
};

/**
 * Build a ReplayLoader that serves a fixed set of traces.
 * Timestamps/randoms are sized to match the trace's step count.
 */
function makeLoader(traces: Map<string, Trace>): ReplayLoader {
  return {
    async loadOriginalTrace(runId: string): Promise<Trace> {
      const trace = traces.get(runId);
      if (!trace) throw new Error(`Loader: trace not found for runId "${runId}"`);
      return trace;
    },
    async loadCacheEntries(runId: string) {
      const trace = traces.get(runId);
      if (!trace) throw new Error(`Loader: artifacts not found for runId "${runId}"`);
      // Produce timestamps from the trace's steps
      const recordedTs = trace.steps.map((s) => s.timestamp);
      return {
        recordedTs,
        recordedNext: Array.from({ length: trace.steps.length }, (_, i) => i / 100),
        recordedUuids: trace.steps.map((_, i) => `uuid-${runId}-${i}`),
        cache: new InMemoryLLMResponseCache(),
      };
    },
  };
}

/**
 * Build a ChainedReplayContext root from scratch (mirrors buildRootContext internals).
 * Used in tests that need to construct a root context without going through replayChain.
 */
function makeRootCtx(
  runId: string,
  ts: number[],
  nextVals: number[],
  uuids: string[],
): ChainedReplayContext {
  return {
    originalRunId: runId,
    replayRunId: `replay-${runId}`,
    mode: "strict",
    clock: new RecordedClock(ts),
    random: new RecordedRandom(nextVals, uuids, "strict"),
    cache: new InMemoryLLMResponseCache(),
    parentRunId: undefined,
    chainDepth: 0,
    chainRootRunId: runId,
  };
}

// ─── Tests: clone() invariant ─────────────────────────────────────────────────

describe("RecordedClock.clone()", () => {
  it("clone starts at parent cursor position", () => {
    const clock = new RecordedClock([10, 20, 30, 40, 50]);
    clock.now(); // cursor → 1
    clock.now(); // cursor → 2

    const child = clock.clone();
    expect(child.getCursor()).toBe(2);
    expect(child.now()).toBe(30); // next value at position 2
  });

  it("clone and original consume independently after split", () => {
    const clock = new RecordedClock([10, 20, 30, 40]);
    clock.now(); // cursor → 1

    const child = clock.clone(); // child starts at cursor 1

    expect(clock.now()).toBe(20); // original continues
    expect(child.now()).toBe(20); // child also returns 20 (same position, independent cursor)

    expect(clock.now()).toBe(30); // original at 3
    expect(child.now()).toBe(30); // child at 3

    expect(clock.now()).toBe(40); // original at 4
    expect(child.now()).toBe(40); // child at 4
  });

  it("clone() exhaustion is independent from original", () => {
    const clock = new RecordedClock([1, 2]);
    const child = clock.clone();

    clock.now();
    clock.now();
    expect(() => clock.now()).toThrow(ClockExhaustedError);

    // Child is independent — still at cursor 0
    expect(child.getCursor()).toBe(0);
    expect(child.now()).toBe(1);
  });
});

describe("RecordedRandom.clone()", () => {
  it("clone starts at parent cursor positions", () => {
    const rng = new RecordedRandom([0.1, 0.2, 0.3], ["u0", "u1", "u2"], "strict");
    rng.next(); // nextCursor → 1
    rng.uuid(); // uuidCursor → 1

    const child = rng.clone();
    expect(child.getNextCursor()).toBe(1);
    expect(child.getUuidCursor()).toBe(1);
    expect(child.next()).toBe(0.2);
    expect(child.uuid()).toBe("u1");
  });

  it("clone and original consume independently", () => {
    const rng = new RecordedRandom([0.1, 0.2, 0.3], ["u0", "u1", "u2"], "strict");
    const child = rng.clone(); // both at cursor 0

    expect(rng.next()).toBe(0.1);
    expect(child.next()).toBe(0.1); // same value, independent cursor

    expect(rng.next()).toBe(0.2);
    expect(child.next()).toBe(0.2);
  });
});

// ─── Tests: CompositeLLMResponseCache / withParent ────────────────────────────

describe("withParent / CompositeLLMResponseCache", () => {
  it("lookup-through: child miss falls back to parent", async () => {
    const parent = new InMemoryLLMResponseCache();
    const key = { provider: "test", model: "m1", messages: [], temperature: 0 };
    await parent.put(key, { content: "from-parent" });

    const composite = withParent(parent, true);
    const entry = await composite.get(key);
    expect(entry?.response).toEqual({ content: "from-parent" });
  });

  it("child hit overrides parent", async () => {
    const parent = new InMemoryLLMResponseCache();
    const child = new InMemoryLLMResponseCache();
    const key = { provider: "test", model: "m1", messages: [], temperature: 0 };
    await parent.put(key, { content: "from-parent" });
    await child.put(key, { content: "from-child" });

    const composite = new CompositeLLMResponseCache(child, parent, false);
    const entry = await composite.get(key);
    expect(entry?.response).toEqual({ content: "from-child" });
  });

  it("readOnly: put() is no-op — parent not polluted", async () => {
    const parent = new InMemoryLLMResponseCache();
    const composite = withParent(parent, true);
    const key = { provider: "test", model: "m2", messages: [], temperature: 0.5 };

    await composite.put(key, { content: "attempted-write" });
    // Should not appear in composite (readOnly=true) nor in parent
    const entryComposite = await composite.get(key);
    const entryParent = await parent.get(key);
    expect(entryComposite).toBeUndefined();
    expect(entryParent).toBeUndefined();
  });

  it("readOnly=false: put() writes to child, not parent", async () => {
    const parent = new InMemoryLLMResponseCache();
    const child = new InMemoryLLMResponseCache();
    const composite = new CompositeLLMResponseCache(child, parent, false);
    const key = { provider: "p", model: "m", messages: [], temperature: 0 };

    await composite.put(key, { content: "child-write" });
    const entryParent = await parent.get(key);
    const entryChild = await child.get(key);
    expect(entryParent).toBeUndefined();
    expect(entryChild?.response).toEqual({ content: "child-write" });
  });

  it("miss in both child and parent returns undefined", async () => {
    const parent = new InMemoryLLMResponseCache();
    const composite = withParent(parent, true);
    const key = { provider: "x", model: "y", messages: ["never"], temperature: 1 };
    const entry = await composite.get(key);
    expect(entry).toBeUndefined();
  });
});

// ─── Tests: propagateContext ───────────────────────────────────────────────────

describe("propagateContext", () => {
  it("derives child with incremented depth and correct parentRunId", () => {
    const rootCtx = makeRootCtx(
      "run-root",
      [100, 200, 300, 400],
      [0.1, 0.2, 0.3, 0.4],
      ["u0", "u1", "u2", "u3"],
    );
    // Simulate root consuming 2 clock + 2 random values
    rootCtx.clock.now();
    rootCtx.clock.now();
    (rootCtx.random as RecordedRandom).next();
    (rootCtx.random as RecordedRandom).uuid();

    const childCtx = propagateContext(rootCtx, "run-child-1");

    expect(childCtx.parentRunId).toBe("run-root");
    expect(childCtx.chainDepth).toBe(1);
    expect(childCtx.chainRootRunId).toBe("run-root");
    expect(childCtx.originalRunId).toBe("run-child-1");
    expect(childCtx.mode).toBe("strict");
  });

  it("child clock continues from parent's last position", () => {
    const rootCtx = makeRootCtx(
      "run-root",
      [10, 20, 30, 40, 50],
      [0.1, 0.2, 0.3, 0.4, 0.5],
      ["u0", "u1", "u2", "u3", "u4"],
    );
    rootCtx.clock.now(); // consumes 10
    rootCtx.clock.now(); // consumes 20

    const childCtx = propagateContext(rootCtx, "run-child");
    // Child should start at position 2 (values 30, 40, 50 remaining)
    expect(childCtx.clock.now()).toBe(30);
    expect(childCtx.clock.now()).toBe(40);
  });

  it("child random continues from parent's last cursor", () => {
    const rootCtx = makeRootCtx("run-root", [10, 20, 30], [0.1, 0.2, 0.3], ["u0", "u1", "u2"]);
    (rootCtx.random as RecordedRandom).next(); // consumes 0.1
    (rootCtx.random as RecordedRandom).uuid(); // consumes u0

    const childCtx = propagateContext(rootCtx, "run-child");
    expect((childCtx.random as RecordedRandom).next()).toBe(0.2);
    expect((childCtx.random as RecordedRandom).uuid()).toBe("u1");
  });

  it("throws TypeError if parentCtx.clock is not RecordedClock", () => {
    // Construct a ctx with a non-RecordedClock to test the guard
    const rootCtx = makeRootCtx("r", [1], [0.1], ["u0"]);
    const fakeCtx = {
      ...rootCtx,
      clock: { now: () => Date.now() }, // plain object, not RecordedClock
    } as unknown as ChainedReplayContext;

    expect(() => propagateContext(fakeCtx, "child")).toThrow(TypeError);
    expect(() => propagateContext(fakeCtx, "child")).toThrow(
      "parentCtx.clock must be a RecordedClock instance",
    );
  });

  it("throws TypeError if parentCtx.random is not RecordedRandom", () => {
    const rootCtx = makeRootCtx("r", [1], [0.1], ["u0"]);
    const fakeCtx = {
      ...rootCtx,
      random: {
        next: () => 0.5,
        uuid: () => "x",
        crypto: async () => new Uint8Array(),
        cryptoUuid: () => "x",
      },
    } as unknown as ChainedReplayContext;

    expect(() => propagateContext(fakeCtx, "child")).toThrow(TypeError);
    expect(() => propagateContext(fakeCtx, "child")).toThrow(
      "parentCtx.random must be a RecordedRandom instance",
    );
  });

  it("multi-level depth propagation: depth increments correctly", () => {
    const ts = Array.from({ length: 20 }, (_, i) => i * 10);
    const nxt = Array.from({ length: 20 }, (_, i) => i / 20);
    const uids = Array.from({ length: 20 }, (_, i) => `u${i}`);

    const root = makeRootCtx("root", ts, nxt, uids);
    const c1 = propagateContext(root, "c1");
    const c2 = propagateContext(c1, "c2");
    const c3 = propagateContext(c2, "c3");
    const c4 = propagateContext(c3, "c4");

    expect(c1.chainDepth).toBe(1);
    expect(c2.chainDepth).toBe(2);
    expect(c3.chainDepth).toBe(3);
    expect(c4.chainDepth).toBe(4);
    // All share the same root
    expect(c4.chainRootRunId).toBe("root");
  });
});

// ─── Tests: replayChain — 5-cycle chain ───────────────────────────────────────

describe("replayChain", () => {
  /**
   * Build a 5-cycle chain: root → c1 → c2 → c3 → c4.
   * Each cycle has 3 steps. Timestamps are arranged so that each subsequent
   * cycle's steps continue from where the previous left off.
   */
  function buildFiveCycleFixture(): { runIds: string[]; loader: ReplayLoader } {
    const runIds = ["root", "c1", "c2", "c3", "c4"];
    const traces = new Map<string, Trace>();

    let ts = 1_000_000;
    for (const id of runIds) {
      const trace = makeTrace(id, ts, 3);
      traces.set(id, trace);
      ts += 100; // each cycle starts 100ms after the previous
    }

    return { runIds, loader: makeLoader(traces) };
  }

  it("5-cycle chain: all cycles match (byte-identical replay)", async () => {
    const { runIds, loader } = buildFiveCycleFixture();
    const result: ChainReplayResult = await replayChain(runIds, loader, identityRunner);

    expect(result.match).toBe(true);
    expect(result.results).toHaveLength(5);
    for (const r of result.results) {
      expect(r.match).toBe(true);
    }
  });

  it("5-cycle chain: correlation chain has correct depth and rootHash", async () => {
    const { runIds, loader } = buildFiveCycleFixture();
    const result = await replayChain(runIds, loader, identityRunner);

    expect(result.correlation.rootRunId).toBe("root");
    const chain = result.correlation.chain;
    expect(chain).toHaveLength(5);

    expect(chain[0].depth).toBe(0);
    expect(chain[0].parentRunId).toBeUndefined();

    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].depth).toBe(i);
      expect(chain[i].parentRunId).toBe(runIds[i - 1]);
    }
  });

  it("chain: match === false when runner produces a divergent trace", async () => {
    const { runIds, loader } = buildFiveCycleFixture();

    // Runner that diverges on c2 (index 2) — changes the rootHash
    const divergentRunner: ReplayRunner = {
      async run(_ctx, originalTrace) {
        if (originalTrace.runId === "c2") {
          return { ...originalTrace, rootHash: "DIVERGED" };
        }
        return originalTrace;
      },
    };

    const result = await replayChain(runIds, loader, divergentRunner);
    expect(result.match).toBe(false);
    // c2 (index 2) should not match
    expect(result.results[2].match).toBe(false);
    // Others still match
    expect(result.results[0].match).toBe(true);
    expect(result.results[1].match).toBe(true);
  });

  it("replayChain with duplicate runId throws RangeError", async () => {
    const { loader } = buildFiveCycleFixture();
    await expect(replayChain(["root", "root", "c1"], loader, identityRunner)).rejects.toThrow(
      RangeError,
    );
    await expect(replayChain(["root", "root", "c1"], loader, identityRunner)).rejects.toThrow(
      'duplicate runId "root"',
    );
  });

  it("replayChain with empty runIds throws RangeError", async () => {
    const { loader } = buildFiveCycleFixture();
    await expect(replayChain([], loader, identityRunner)).rejects.toThrow(RangeError);
  });

  it("single runId replays just the root cycle", async () => {
    const { loader } = buildFiveCycleFixture();
    const result = await replayChain(["root"], loader, identityRunner);
    expect(result.results).toHaveLength(1);
    expect(result.match).toBe(true);
    expect(result.correlation.chain[0].runId).toBe("root");
  });
});

// ─── Tests: MissingParentRunError ─────────────────────────────────────────────

describe("MissingParentRunError", () => {
  it("has correct name, message, and properties", () => {
    const err = new MissingParentRunError("child-run", "missing-parent");
    expect(err.name).toBe("MissingParentRunError");
    expect(err.runId).toBe("child-run");
    expect(err.parentRunId).toBe("missing-parent");
    expect(err.message).toContain("child-run");
    expect(err.message).toContain("missing-parent");
  });
});

// ─── Tests: replayFromWithParent ──────────────────────────────────────────────

describe("replayFromWithParent", () => {
  it("without parentCtx: delegates to standard replayFrom → match", async () => {
    const traces = new Map<string, Trace>();
    traces.set("run-1", makeTrace("run-1", 1_000_000, 3));
    const loader = makeLoader(traces);

    const result: ReplayResult = await replayFromWithParent("run-1", loader, identityRunner);
    expect(result.match).toBe(true);
  });

  it("with parentCtx: child cycle replayed alone matches original rootHash", async () => {
    const traces = new Map<string, Trace>();
    traces.set("root", makeTrace("root", 1_000_000, 2));
    traces.set("child", makeTrace("child", 1_001_000, 2));
    const loader = makeLoader(traces);

    // Build a root ctx manually (simulates root having finished)
    const rootTs = [1_000_000, 1_000_010];
    const rootNxt = [0.1, 0.2];
    const rootUids = ["u0", "u1"];
    const rootCtx = makeRootCtx("root", rootTs, rootNxt, rootUids);
    // Consume all root timestamps (simulating root cycle completed)
    rootCtx.clock.now();
    rootCtx.clock.now();

    const result = await replayFromWithParent("child", loader, identityRunner, {
      parentCtx: rootCtx,
    });
    expect(result.match).toBe(true);
  });
});
