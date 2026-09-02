/**
 * slo-002-loop-measurements.test.ts
 *
 * Real, wall-clock measurements backing REQ-SLO-002 (docs/preste-v2/03-spec/
 * 2026-08-19-spec-normative-v2.md, C7) for three of the seven SLO axes that
 * live in `@vauban-org/agent-sdk`'s loop: SLO-FF (first feedback), SLO-STALL
 * (streaming stall), SLO-CANCEL/SLO-ABORT (cancel-to-stop / abort-to-
 * quiescence). This file does not assert regression thresholds (no CI gate
 * yet, see REQ-SLO-001) ; each `it()` records real numbers to `console.log`
 * so a human transcribes them into the spec. Assertions only check the
 * QUALITATIVE property each SLO axis cares about (e.g. "no future effect
 * after cancel is accepted"), never a fabricated latency budget.
 *
 * Methodology note (read before trusting a number here): every mock
 * ProviderRouter below resolves synchronously or on a controlled setTimeout ;
 * there is no real LLM network call. These numbers are therefore a FLOOR
 * (pure harness/loop overhead), not the real user-facing latency a live
 * Anthropic/Groq call would show. See REQ-SLO-002 in the spec for how this
 * floor is used (bound, not budget).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type ProviderRouter,
  type ProviderRouterResponse,
  createBudgetState,
} from "../src/index.js";
import { TextDeltaCoalescer } from "../src/loop/text-delta-coalescer.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

function resp(
  content: string,
  toolCalls: ProviderRouterResponse["toolCalls"] = [],
): ProviderRouterResponse {
  return {
    provider: "mock",
    content,
    toolCalls,
    usage: { inputTokens: 5, outputTokens: 3 },
    latencyMs: 0,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function stats(samples: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

// ─── SLO-FF ; first-feedback harness floor ─────────────────────────────────
//
// Measures wall-clock time from `loop.run()` invocation to the FIRST
// eventSink.emit() call (tool.call.start), with a provider that resolves
// with zero artificial delay. This isolates loop/OTel/gate bookkeeping
// overhead from network+LLM latency (not measured here ; no live provider
// budget for this task).

describe("SLO-FF ; first observable output, harness floor", () => {
  it("measures time-to-first-emit over 30 runs (mock provider, zero network)", async () => {
    const N = 30;
    const deltasMs: number[] = [];

    for (let i = 0; i < N; i++) {
      const reg = new ToolRegistryImpl();
      reg.register({
        name: "noop",
        description: "no-op",
        parameters: z.object({}).strict(),
        execute: async () => ({ ok: true, done: true }),
      });

      const provider: ProviderRouter = {
        async complete() {
          return resp("", [{ name: "noop", args: {} }]);
        },
      };

      let firstEmitAt: number | null = null;
      const t0 = performance.now();
      const eventSink = {
        emit() {
          if (firstEmitAt === null) firstEmitAt = performance.now();
        },
      };

      const loop = new AgentLoop({
        agentId: "slo-ff",
        agentVersion: "test",
        systemPrompt: "sys",
        provider,
        tools: reg,
        budget: createBudgetState({ maxSteps: 2 }),
        disableLoopDetection: true,
        eventSink,
      });

      await loop.run("go");
      expect(firstEmitAt).not.toBeNull();
      deltasMs.push((firstEmitAt as unknown as number) - t0);
    }

    const s = stats(deltasMs);
    // eslint-disable-next-line no-console
    console.log(
      `[SLO-FF floor] N=${N} p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`,
    );
    // Qualitative only: the floor must stay well under any real network RTT
    // (sanity bound, not the SLO itself ; see REQ-SLO-002).
    expect(s.p95).toBeLessThan(50);
  });
});

// ─── SLO-CANCEL ; cancel-to-stop, no tool dispatched yet ───────────────────
//
// Fires abort() WHILE the provider call for step 1 is still in flight (30ms
// controlled delay). The loop's checkpoint at the top of the tool-dispatch
// loop (minimal-loop.ts, before `tools.execute`) must observe the abort and
// skip dispatch entirely ; proving the future effect never happens, not just
// that a flag was set.

describe("SLO-CANCEL ; cancel before a future tool dispatch", () => {
  it("prevents the tool's effect and measures cancel-accepted -> stop delay (20 trials)", async () => {
    const N = 20;
    const deltasMs: number[] = [];
    let preventedCount = 0;

    for (let i = 0; i < N; i++) {
      const executedEffects: string[] = [];
      const reg = new ToolRegistryImpl();
      reg.register({
        name: "would_run",
        description: "records if it ran",
        parameters: z.object({}).strict(),
        execute: async () => {
          executedEffects.push("ran");
          return { ok: true };
        },
      });

      const PROVIDER_DELAY_MS = 30;
      const provider: ProviderRouter = {
        async complete() {
          await new Promise((r) => setTimeout(r, PROVIDER_DELAY_MS));
          return resp("", [{ name: "would_run", args: {} }]);
        },
      };

      const controller = new AbortController();
      const loop = new AgentLoop({
        agentId: "slo-cancel",
        agentVersion: "test",
        systemPrompt: "sys",
        provider,
        tools: reg,
        budget: createBudgetState({ maxSteps: 3 }),
        disableLoopDetection: true,
        abortSignal: controller.signal,
      });

      const runPromise = loop.run("go");
      let tAbort = 0;
      setTimeout(() => {
        tAbort = performance.now();
        controller.abort();
      }, 5); // well inside the 30ms provider delay

      const result = await runPromise;
      const tResolve = performance.now();

      expect(result.stopReason).toBe("aborted");
      if (executedEffects.length === 0) preventedCount++;
      deltasMs.push(tResolve - tAbort);
    }

    const s = stats(deltasMs);
    // eslint-disable-next-line no-console
    console.log(
      `[SLO-CANCEL pre-dispatch] N=${N} prevented=${preventedCount}/${N} ` +
        `p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`,
    );
    // Qualitative CC-EXE-007-adjacent property: the future effect must be
    // prevented every time, not merely usually.
    expect(preventedCount).toBe(N);
  });
});

// ─── SLO-ABORT ; a tool already in flight is NOT preempted ────────────────
//
// This is the honest negative result the spec text (REQ-EXE-007) already
// names: once `tools.execute()` has been awaited, there is no cooperative
// checkpoint inside it. Abort only takes effect at the NEXT loop boundary,
// after the in-flight tool call finishes on its own. This test measures
// the loop's added overhead ON TOP OF the tool's own remaining running time
// (should be near-zero) ; it does NOT show true forced preemption, because
// none exists today for tools without their own AbortController wiring
// (run_bash included ; see standalone-tools.ts, no `signal` passed to the
// child process as of this spec).

describe("SLO-ABORT ; in-flight tool call is not preempted (documents the real gap)", () => {
  it("measures added overhead after the in-flight tool's own delay elapses (15 trials)", async () => {
    const N = 15;
    const overheadMs: number[] = [];
    let ranToCompletionCount = 0;

    for (let i = 0; i < N; i++) {
      const TOOL_DELAY_MS = 40;
      let toolFinishedAt = 0;
      const reg = new ToolRegistryImpl();
      reg.register({
        name: "slow_tool",
        description: "a tool that keeps running once dispatched",
        parameters: z.object({}).strict(),
        execute: async () => {
          await new Promise((r) => setTimeout(r, TOOL_DELAY_MS));
          toolFinishedAt = performance.now();
          ranToCompletionCount++;
          return { ok: true };
        },
      });

      const provider: ProviderRouter = {
        async complete() {
          return resp("", [{ name: "slow_tool", args: {} }]);
        },
      };

      const controller = new AbortController();
      const loop = new AgentLoop({
        agentId: "slo-abort",
        agentVersion: "test",
        systemPrompt: "sys",
        provider,
        tools: reg,
        budget: createBudgetState({ maxSteps: 3 }),
        disableLoopDetection: true,
        abortSignal: controller.signal,
      });

      const runPromise = loop.run("go");
      // Fire abort almost immediately ; well BEFORE the tool's own 40ms
      // completes, so this genuinely tests "can it be preempted", not just
      // "does it stop before dispatch" (that's the SLO-CANCEL test above).
      setTimeout(() => controller.abort(), 5);

      const result = await runPromise;
      const tResolve = performance.now();

      expect(result.stopReason).toBe("aborted");
      overheadMs.push(tResolve - toolFinishedAt);
    }

    const s = stats(overheadMs);
    // eslint-disable-next-line no-console
    console.log(
      `[SLO-ABORT in-flight] N=${N} tool_ran_to_completion=${ranToCompletionCount}/${N} ` +
        `added_overhead_p50=${s.p50.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`,
    );
    // The documented gap: today, an in-flight tool ALWAYS runs to
    // completion despite abort() firing early. This is not a bug in this
    // test ; it is the real, current behavior REQ-EXE-007 flags.
    expect(ranToCompletionCount).toBe(N);
  });
});

// ─── SLO-STALL ; TextDeltaCoalescer's configured silence ceiling ──────────
//
// text-delta-coalescer.ts documents (and defaults) maxIntervalMs=350 as the
// bound on how long buffered-but-unflushed text can sit before a flush is
// forced. This test verifies that bound holds under REAL wall-clock timing
// (no fake timers) ; and separately documents the important caveat already
// written in the module's own header: the interval branch only re-checks
// INSIDE push(), so it is dormant whenever no new text arrives at all
// (today's production reality per the module comment: ProviderRouter
// returns whole blocks, not token deltas).

describe("SLO-STALL ; coalescer flush ceiling (real wall clock)", () => {
  it("flushes within ~maxIntervalMs of the last flush once a new push arrives", async () => {
    const flushes: Array<{ text: string; atMs: number }> = [];
    const t0 = performance.now();
    const coalescer = new TextDeltaCoalescer({
      onFlush: (text) => flushes.push({ text, atMs: performance.now() - t0 }),
      maxIntervalMs: 350,
      maxChars: 999_999, // keep the size branch out of the way
    });

    coalescer.push("first chunk");
    await new Promise((r) => setTimeout(r, 400)); // exceed the 350ms ceiling
    coalescer.push("second chunk"); // interval branch re-checked HERE

    expect(flushes).toHaveLength(1);
    expect(flushes[0].atMs).toBeGreaterThanOrEqual(350);
    // eslint-disable-next-line no-console
    console.log(
      `[SLO-STALL] configured maxIntervalMs=350 ; observed flush at ${flushes[0].atMs.toFixed(1)}ms (source: packages/agent-sdk/src/loop/text-delta-coalescer.ts:35)`,
    );
  });

  it("documents: with NO further push(), the interval branch never fires (real silence is unbounded today)", async () => {
    const flushes: string[] = [];
    const coalescer = new TextDeltaCoalescer({
      onFlush: (text) => flushes.push(text),
      maxIntervalMs: 50,
      maxChars: 999_999,
    });
    coalescer.push("buffered, never flushed by a timer");
    await new Promise((r) => setTimeout(r, 500)); // far past maxIntervalMs
    expect(flushes).toHaveLength(0); // no push() call => no re-check => no flush
    coalescer.flush(); // only an explicit finalize() drains it (as the loop does)
    expect(flushes).toHaveLength(1);
  });
});
