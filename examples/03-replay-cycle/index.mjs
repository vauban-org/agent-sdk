/**
 * Example 03 — Replay Cycle: live mode vs replay mode side by side.
 *
 * Demonstrates the V7-2 critical pattern: every skill and phase MUST check
 * ctx.isReplay and skip observable side effects when true.
 *
 * The same agent is triggered twice:
 *   1. Live mode  (isReplay=false) — would call external APIs in production.
 *   2. Replay mode (isReplay=true) — returns mock data, no side effects.
 *
 * Both cycles produce structurally identical outputs so downstream phases
 * are deterministic regardless of mode.
 *
 * Run:
 *   npm install @vauban/agent-sdk starknet@6
 *   node index.mjs
 */

import { createOODAAgent, noopLogger } from "@vauban/agent-sdk";

// ─── Mock infrastructure ────────────────────────────────────────────────────

const stubDb = { query: async () => ({ rows: [] }) };

// Simulates a live API call (would be a real HTTP fetch in production).
async function fetchLiveQuote(symbol) {
  // In a real agent, this would call Alpaca/Broker API.
  return { symbol, price: 21_500.0, source: "live" };
}

// ─── Shared phase definitions ───────────────────────────────────────────────

// dryRunMocks: fixture data returned by skills when ctx.isReplay === true.
// V7-2 pattern: the mock is co-located with the skill call, not in a
// separate fixture file — easier to keep in sync.
const REPLAY_QUOTE = { symbol: "NQ", price: 21_000.0, source: "replay" };

function makePhaseDefs() {
  return {
    // Phase 1 — OBSERVE: live call vs replay mock (V7-2 critical pattern)
    observe: {
      type: "observation",
      readOnly: true,
      fn: async (_input, ctx) => {
        let quote;

        if (ctx.isReplay) {
          // V7-2: return deterministic mock — no HTTP call, no side effect.
          quote = REPLAY_QUOTE;
          console.log(`[observe] REPLAY — returning mock quote`);
        } else {
          // Live mode: would call external API in production.
          quote = await fetchLiveQuote("NQ");
          console.log(`[observe] LIVE — fetched quote from ${quote.source}`);
        }

        return quote;
      },
    },

    // Phase 2 — ORIENT: identical logic regardless of mode
    orient: {
      type: "retrieval",
      readOnly: true,
      fn: async (obs, ctx) => {
        const label = ctx.isReplay ? "REPLAY" : "LIVE";
        const regime = obs.price > 21_200 ? "above-avg" : "below-avg";
        console.log(`[orient] ${label} price=${obs.price} regime=${regime}`);
        return { regime, source: obs.source };
      },
    },

    // Phase 3 — DECIDE
    decide: {
      type: "decision",
      fn: async (orientation, ctx) => {
        const label = ctx.isReplay ? "REPLAY" : "LIVE";
        const action = orientation.regime === "above-avg" ? "hold" : "watch";
        console.log(`[decide] ${label} action=${action}`);
        return { action };
      },
    },

    // Phase 4 — ACT: side effects only in live mode (V7-2 pattern)
    act: {
      type: "execution",
      fn: async (decision, ctx) => {
        if (ctx.isReplay) {
          // V7-2: no Slack, no broker call, no DB write in replay.
          console.log(`[act] REPLAY — skipping side effects`);
          return { sent: false };
        }

        // Live mode: would send notification, place order, etc.
        console.log(
          `[act] LIVE — action=${decision.action} (dry-run: no real order)`,
        );
        return { sent: true };
      },
    },

    // Phase 5 — FEEDBACK
    feedback: {
      type: "feedback",
      fn: async (result, ctx) => {
        const label = ctx.isReplay ? "REPLAY" : "LIVE";
        console.log(`[feedback] ${label} sent=${result.sent}`);
        return { ok: true };
      },
    },
  };
}

// ─── Agent ──────────────────────────────────────────────────────────────────

const agent = createOODAAgent({
  agentId: "replay-demo",
  intervalMs: 60_000,
  executionMode: "dry-run",
  logger: noopLogger,
  db: stubDb,
  phases: makePhaseDefs(),
});

// ── Cycle 1: live mode ────────────────────────────────────────────────────
console.log("=== Cycle 1: live mode (dryRun=false, isReplay=false) ===");
const live = await agent.triggerCycle({ dryRun: false });
console.log(`status=${live.status} runId=${live.runId}\n`);

// ── Cycle 2: replay mode ──────────────────────────────────────────────────
// triggerCycle with dryRun:true sets isReplay=true inside the context.
// The same phase code runs, but every branch guarded by ctx.isReplay
// returns mock data instead of calling live APIs.
console.log("=== Cycle 2: replay mode (dryRun=true, isReplay=true) ===");
const replay = await agent.triggerCycle({ dryRun: true });
console.log(`status=${replay.status} runId=${replay.runId}`);

if (live.status === "failed" || replay.status === "failed") {
  process.exit(1);
}
