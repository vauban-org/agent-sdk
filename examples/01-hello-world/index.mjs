/**
 * Example 01 — Hello World: minimal OODA agent, one dry-run cycle.
 *
 * Demonstrates the five phases of the OODA loop:
 *   observe → orient → decide → act → feedback
 *
 * No backend required. No API keys. Exits 0 on success.
 *
 * Run:
 *   npm install @vauban/agent-sdk starknet@6
 *   node index.mjs
 */

import { createOODAAgent, noopLogger } from "@vauban/agent-sdk";

// Minimal stub — examples don't need a real Postgres connection.
const stubDb = { query: async () => ({ rows: [] }) };

const agent = createOODAAgent({
  agentId: "hello-world",
  intervalMs: 5_000, // loop interval (irrelevant for triggerCycle)
  executionMode: "dry-run", // REQUIRED (anti-pattern #6 — no implicit default)
  logger: noopLogger, // SDK 0.8.1+: default is noopLogger
  db: stubDb,

  phases: {
    // Phase 1 — OBSERVE: gather raw data from the environment (readOnly required)
    observe: {
      type: "observation",
      readOnly: true,
      fn: async (_input, ctx) => {
        console.log(
          `[observe] cycle=${ctx.cycleIndex} mode=${ctx.executionMode}`,
        );
        return { timestamp: new Date().toISOString(), value: 42 };
      },
    },

    // Phase 2 — ORIENT: interpret observations (readOnly required)
    orient: {
      type: "retrieval",
      readOnly: true,
      fn: async (obs, _ctx) => {
        console.log(`[orient] observed value=${obs.value} at ${obs.timestamp}`);
        return { trend: obs.value > 30 ? "high" : "low" };
      },
    },

    // Phase 3 — DECIDE: choose an action based on orientation
    decide: {
      type: "decision",
      fn: async (orientation, _ctx) => {
        console.log(`[decide] trend=${orientation.trend}`);
        return { action: orientation.trend === "high" ? "alert" : "hold" };
      },
    },

    // Phase 4 — ACT: execute the decision (side effects happen here)
    act: {
      type: "execution",
      fn: async (decision, ctx) => {
        // In dry-run mode, no real side effects are produced.
        console.log(`[act] action=${decision.action} replay=${ctx.isReplay}`);
        return { dispatched: decision.action };
      },
    },

    // Phase 5 — FEEDBACK: record outcome, close the loop
    feedback: {
      type: "feedback",
      fn: async (result, _ctx) => {
        console.log(`[feedback] dispatched=${result.dispatched}`);
        return { ok: true };
      },
    },
  },
});

// triggerCycle runs exactly one cycle synchronously and returns.
// dryRun: true overrides executionMode to "dry-run" for this call.
const { runId, status } = await agent.triggerCycle({ dryRun: true });

console.log(`\nDone. runId=${runId} status=${status}`);

if (status !== "succeeded") {
  process.exit(1);
}
