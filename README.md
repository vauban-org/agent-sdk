# Vauban Agent SDK — OODA primitive with proof-anchored execution

[![npm](https://img.shields.io/npm/v/@vauban/agent-sdk)](https://www.npmjs.com/package/@vauban/agent-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)

Production-grade agent orchestration for autonomous systems. Every execution step
gets a Poseidon-hashed leaf anchored on Starknet L3 — auditable, offline-verifiable,
zero trust in your observability backend.

---

## Why this SDK?

| Feature | Vauban Agent SDK | Hermes (NousResearch) | OpenClaw |
|---|---|---|---|
| Execution proofs | Poseidon leaf hash per step, anchored on Starknet L3 | None | None |
| Offline verification | `vauban-verify` Python CLI — no backend required | N/A | N/A |
| Anti-pattern enforcement | 10 enforced by API design (see below) | Manual discipline | Manual discipline |
| HITL gate | Built-in, transport-agnostic | Plugin | Plugin |
| Circuit breaker | Explicit reset modes — no TTL blind reset | Configurable TTL | Configurable TTL |
| Session guards | NYSE/CME RTH out of the box | Custom implementation | Custom implementation |
| Replay safety | `ctx.isReplay` on every phase and skill call | Not specified | Not specified |
| Resource limits | 60s/256MB/200 steps — configurable, enforced | Manual | Manual |
| Skills catalog | 13 builtin, proof-instrumented | 118 builtin, no proof | Varies |

The core difference: **every step is cryptographically accountable**. You can hand an
auditor a run certificate and they can verify it offline without access to your
observability stack.

---

## Quick install

```bash
npm install @vauban/agent-sdk starknet@6
```

Node >= 20 required. ESM only.

---

## 3-minute Hello World

```javascript
import { createOODAAgent, noopLogger } from "@vauban/agent-sdk";

const agent = createOODAAgent({
  agentId: "hello-world",
  intervalMs: 5_000,
  executionMode: "dry-run",   // required — anti-pattern #6: no implicit default
  logger: noopLogger,
  db: { query: async () => ({ rows: [] }) },

  phases: {
    observe: {
      type: "observation",
      readOnly: true,
      fn: async (_input, ctx) => {
        console.log(`[observe] cycle=${ctx.cycleIndex}`);
        return { timestamp: new Date().toISOString() };
      },
    },
    orient: {
      type: "retrieval",
      readOnly: true,
      fn: async (obs, _ctx) => {
        console.log(`[orient] observed at ${obs.timestamp}`);
        return { signal: "neutral" };
      },
    },
    decide: {
      type: "decision",
      fn: async (orientation, _ctx) => {
        console.log(`[decide] signal=${orientation.signal}`);
        return { action: "hold" };
      },
    },
    act: {
      type: "execution",
      fn: async (decision, ctx) => {
        console.log(`[act] ${decision.action} (mode=${ctx.executionMode})`);
        return { executed: true };
      },
    },
    feedback: {
      type: "feedback",
      fn: async (result, _ctx) => {
        console.log(`[feedback] executed=${result.executed}`);
        return { ok: true };
      },
    },
  },
});

// One-shot dry-run cycle — no loop, no side effects
const { runId, status } = await agent.triggerCycle({ dryRun: true });
console.log(`run=${runId} status=${status}`);
```

See [examples/01-hello-world/](./examples/01-hello-world/) for the complete runnable version.

---

## Architecture

The OODA loop is the core primitive. Each cycle executes five phases in strict sequence:

```
observe  →  orient  →  decide  →  act  →  feedback
  │            │          │         │         │
readOnly     readOnly    decide   execute   record
(no writes) (no writes) (no tx)  (+HITL?)  outcome
```

Each phase is a typed function: `(TInput, OODAContext) => Promise<TOutput>`. The output
of each phase is the input of the next — compile-time type-safe chaining.

The `OODAContext` carries:
- `agentId`, `runId`, `cycleIndex`, `executionMode`, `isReplay`
- `db`, `skills`, `logger`
- `insertStep` / `completeStep` / `errorStep` — proof step persistence
- `notifySlack` — routed notification (noop in dry-run)

### Proof anchoring

Every `completeStep` call computes a `leafHash` (Poseidon over the step payload).
The `assembleRunCertificate` function builds a Merkle-like certificate over all leaf
hashes in a run. The certificate can be anchored on Starknet L3 and verified offline:

```bash
pip install vauban-verify
vauban-verify run <run-id> --cert ./run-cert.json
```

---

## Skills catalog (13 builtin)

Each skill is a pure function with a strict Zod input schema. Every invocation
emits a proof step with `leaf_hash_poseidon` — auditors can prove "agent X called
skill Y with input Z at time T".

| Skill | Import | Description |
|---|---|---|
| `web_search` | `webSearch` | Brave/SerpAPI search, sanitized output |
| `alpaca_quote` | `alpacaQuote` | Real-time equity quote from Alpaca |
| `brain_store` | `brainStore` | Archive knowledge entry to Brain MCP |
| `brain_query` | `brainQuery` | Semantic search in Brain MCP |
| `telegram_notify` | `telegramNotify` | Send Telegram message (noop in dry-run) |
| `slack_notify` | `slackNotify` | Post to Slack channel (noop in dry-run) |
| `send_email` | `sendEmail` | Send transactional email (noop in dry-run) |
| `run_sql_query` | `runSqlQuery` | Read-only SQL query with allowlist validation |
| `cboe_vix_spot` | `cboeVixSpot` | CBOE VIX spot via public CBOE endpoint |
| `starknet_balance` | `starknetBalance` | ERC-20/ETH balance on Starknet |
| `calendar_check` | `calendarCheck` | Check CME/NYSE calendar for trading sessions |
| `hitl_request` | `hitlRequest` | Request human-in-the-loop approval |
| `http_fetch` | `httpFetch` | Allowlisted HTTP GET/POST |

```javascript
import { cboeVixSpot, webSearch } from "@vauban/agent-sdk";

const vix = await cboeVixSpot({}, ctx);
// { vix: 18.32, timestamp: "2026-04-28T14:30:00Z", source: "cboe" }
```

---

## Guards

### Session guards — gate entire cycles

```javascript
import { rthSession } from "@vauban/agent-sdk";

// Cycle only runs Mon-Fri 09:30-16:00 ET, excluding CME holidays
const agent = createOODAAgent({
  // ...
  sessionGuards: [rthSession()],
});
```

### Risk guards — per-cycle adversarial checks

```javascript
import { redisCircuitBreaker } from "@vauban/agent-sdk";

const agent = createOODAAgent({
  // ...
  riskGuards: [
    redisCircuitBreaker({
      name: "broker-api",
      failureThreshold: 3,
      resetVia: "cron-rth",   // explicit reset — not TTL-based (anti-pattern #4)
    }),
  ],
});
```

---

## Brain context injection

Auto-inject relevant Brain knowledge into the orient phase without boilerplate:

```javascript
import { withBrainContext } from "@vauban/agent-sdk";

const agent = createOODAAgent({
  phases: {
    orient: {
      type: "retrieval",
      readOnly: true,
      fn: withBrainContext(
        {
          enabled: true,
          query: (obs) => `market signal ${obs.symbol}`,
          topK: 5,
          minSimilarity: 0.7,
          fetchBrainContext: myBrainAdapter,
        },
        async ({ raw, brainContext }, ctx) => {
          // brainContext: BrainChunk[] filtered by similarity
          // brainContextRefs: entry IDs lifted onto the proof certificate
          return { signal: "neutral", context: brainContext };
        },
      ),
    },
    // ...
  },
});
```

---

## 10 enforced anti-patterns

These are not guidelines — they are enforced by the API design and validated at
runtime in `OODAAgentImpl`:

| # | Anti-pattern | Enforcement |
|---|---|---|
| 1 | Sequential `while+sleep` loop — no `setInterval` | `start()` uses `while+await sleep()` internally |
| 2 | Step persistence `pending → done` | `insertStep` + `completeStep` required per phase |
| 3 | HITL gate on `act` | `hitlGate: true` on act phase awaits human approval |
| 4 | No TTL bypass on risk guards | Guards checked every cycle; no expiry shortcut |
| 5 | Session guards checked each cycle | Cycle skipped entirely if any guard returns false |
| 6 | `executionMode` required at construction | TypeScript required field — no implicit default |
| 7 | `observe` and `orient` must be `readOnly: true` | Constructor throws if violated |
| 8 | Clean abort when guard trips | No LLM/skill calls after a guard returns `proceed: false` |
| 9 | Configurable resource limits | `phaseTimeoutMs` (60s), `maxStepsPerCycle` (200), `maxHeapMb` (256MB) |
| 10 | Heap and step usage monitored | Exceeding limits logs + aborts the cycle |

---

## Replay safety

Every skill and phase receives `ctx.isReplay`. When true, all observable side effects
must be skipped. Builtin skills enforce this — `dryRunMocks` provide deterministic
fixture data for replay runs:

```javascript
// In dry-run: skills return dryRunMocks instead of calling live APIs
const { runId, status } = await agent.triggerCycle({ dryRun: true });
```

---

## Examples

| Example | Description |
|---|---|
| [01-hello-world/](./examples/01-hello-world/) | Minimal 5-phase OODA agent, dry-run, no deps |
| [02-trading-agent/](./examples/02-trading-agent/) | Mock VIX+price+ATR, circuit breaker, RTH session guard, Brain context |
| [03-replay-cycle/](./examples/03-replay-cycle/) | Live vs replay mode, `dryRunMocks`, V7-2 replay pattern |

---

## Sister packages

| Package | Registry | Purpose |
|---|---|---|
| `vauban-verify` | [PyPI](https://pypi.org/project/vauban-verify/) | Offline run certificate verifier — no backend required |
| `cc-schemas` | [GitHub](https://github.com/vauban-org/cc-schemas) | PostgreSQL schemas for `run_steps`, `proof_certificates`, `outcomes` |

---

## License

MIT — see [LICENSE](./LICENSE).

---

Built by [Vauban](https://vauban.tech) — institutional-grade agent observability
with cryptographic accountability.
