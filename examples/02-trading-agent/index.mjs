/**
 * Example 02 — Trading Agent: mock VIX + price + ATR, guards, Brain context.
 *
 * Demonstrates:
 *   - withBrainContext (mocked fetchBrainContext — no Brain server needed)
 *   - redisCircuitBreaker guard (config-only; mocked Redis client)
 *   - rthSession session guard (bypassed in dry-run via mock date)
 *   - Mock market data in each phase
 *
 * Anti-pattern callouts are inline with the corresponding lines.
 *
 * Run:
 *   npm install @vauban/agent-sdk starknet@6
 *   node index.mjs
 */

import {
  createOODAAgent,
  noopLogger,
  withBrainContext,
  rthSession,
  redisCircuitBreaker,
} from "@vauban/agent-sdk";

// ─── Mock infrastructure ────────────────────────────────────────────────────

const stubDb = { query: async () => ({ rows: [] }) };

// Mock Brain fetcher — returns deterministic chunks (no Brain server needed).
async function mockFetchBrainContext(query, topK) {
  return {
    result: [
      {
        entry_id: "mock-entry-001",
        content: `Historical context for query: "${query}"`,
        similarity: 0.85,
      },
    ],
    mcp_call_hash: "0xdeadbeef",
    retrieval_proof_hash: "0xcafebabe",
  };
}

// Mock Redis client — satisfies MinimalRedisClient interface without ioredis.
// Anti-pattern #4: circuit breaker uses explicit key ("1" = tripped) — no TTL.
function mockRedisFactory(_url) {
  const store = new Map(); // empty = not tripped
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => store.set(key, value),
    del: async (key) => store.delete(key),
    quit: async () => undefined,
  };
}

// ─── Guards ─────────────────────────────────────────────────────────────────

// Anti-pattern #5: session guards are checked every cycle — no caching, no TTL.
// rthSession skips cycles outside NYSE/CME Regular Trading Hours (09:30-16:00 ET).
// In this example, the agent runs with triggerCycle so the guard is checked once.
const sessionGuards = [rthSession()];

// Anti-pattern #4: redisCircuitBreaker uses resetVia: "cron-rth" — the circuit
// stays tripped until an external cron job explicitly resets it. No TTL blind reset.
const riskGuards = [
  redisCircuitBreaker({
    name: "broker-api",
    failureThreshold: 3,
    resetVia: "cron-rth", // anti-pattern #4: explicit, not TTL-based
    _redisClientFactory: mockRedisFactory, // inject mock — no real Redis needed
  }),
];

// ─── Agent ──────────────────────────────────────────────────────────────────

const agent = createOODAAgent({
  agentId: "trading-agent",
  intervalMs: 60_000,
  executionMode: "dry-run", // anti-pattern #6: required, no implicit default
  logger: noopLogger,
  db: stubDb,
  sessionGuards,
  riskGuards,

  // Resource limits — anti-pattern #9+#10: enforced at runtime.
  resourceLimits: {
    phaseTimeoutMs: 10_000, // 10s per phase (default: 60s)
    maxStepsPerCycle: 50, // default: 200
    maxHeapMb: 128, // default: 256MB
  },

  phases: {
    // Phase 1 — OBSERVE: fetch mock market snapshot (readOnly — anti-pattern #7)
    observe: {
      type: "observation",
      readOnly: true, // anti-pattern #7: observe MUST be readOnly
      fn: async (_input, ctx) => {
        const snapshot = {
          symbol: "NQ",
          price: 21_450.25,
          vix: 16.8,
          atr14: 310.5,
          timestamp: new Date().toISOString(),
        };
        console.log(`[observe] price=${snapshot.price} vix=${snapshot.vix}`);
        return snapshot;
      },
    },

    // Phase 2 — ORIENT: withBrainContext auto-injects relevant knowledge.
    // The wrapper inserts a retrieval step, calls fetchBrainContext, and
    // passes filtered chunks to the inner orient function. Replay-safe:
    // when ctx.isReplay === true, it returns replayChunks instead of calling Brain.
    orient: {
      type: "retrieval",
      readOnly: true, // anti-pattern #7: orient MUST be readOnly
      fn: withBrainContext(
        {
          enabled: true,
          query: (obs) => `NQ futures ${obs.symbol} regime`,
          topK: 3,
          minSimilarity: 0.7,
          fetchBrainContext: mockFetchBrainContext,
          replayChunks: [
            {
              entry_id: "replay-entry-001",
              content: "NQ replay context",
              similarity: 0.9,
            },
          ],
        },
        async ({ raw, brainContext }, ctx) => {
          const regime =
            raw.vix < 20 ? "low-vol" : raw.vix < 30 ? "elevated" : "crisis";
          console.log(
            `[orient] regime=${regime} brainChunks=${brainContext.length}`,
          );
          return {
            symbol: raw.symbol,
            price: raw.price,
            atr14: raw.atr14,
            regime,
            brainRefs: brainContext.map((c) => c.entry_id),
          };
        },
      ),
    },

    // Phase 3 — DECIDE: generate trade signal from orientation
    decide: {
      type: "decision",
      fn: async (orientation, _ctx) => {
        const risk = orientation.atr14 * 1.5;
        const signal = orientation.regime === "low-vol" ? "buy" : "flat";
        console.log(`[decide] signal=${signal} risk=${risk}`);
        return { symbol: orientation.symbol, signal, riskPoints: risk };
      },
    },

    // Phase 4 — ACT: execute order (dry-run: no real broker calls)
    // hitlGate: true would pause here for human approval before continuing.
    act: {
      type: "execution",
      hitlGate: false, // set true to require human approval (anti-pattern #3)
      fn: async (decision, ctx) => {
        if (decision.signal === "flat") {
          console.log(`[act] flat — no order`);
          return { orderId: null };
        }
        // In dry-run: ctx.executionMode === "dry-run" — no real order sent.
        console.log(
          `[act] ${decision.signal} ${decision.symbol} mode=${ctx.executionMode}`,
        );
        return { orderId: ctx.isReplay ? null : `mock-order-${Date.now()}` };
      },
    },

    // Phase 5 — FEEDBACK: record outcome
    feedback: {
      type: "feedback",
      fn: async (result, _ctx) => {
        console.log(`[feedback] orderId=${result.orderId ?? "none"}`);
        return { ok: true, orderId: result.orderId };
      },
    },
  },
});

// One-shot cycle in dry-run mode.
// sessionGuards are checked — if outside RTH the status will be "skipped".
const { runId, status } = await agent.triggerCycle({ dryRun: true });
console.log(`\nDone. runId=${runId} status=${status}`);

if (status === "failed") {
  process.exit(1);
}
