# Trading Agent — guards, Brain context, circuit breaker

A mock trading-style OODA agent demonstrating the three major guard/context
primitives without requiring any external services.

## Run

```bash
cd examples/02-trading-agent
npm install @vauban/agent-sdk starknet@6
node index.mjs
```

## Expected output

```
[observe] price=21450.25 vix=16.8
[orient] regime=low-vol brainChunks=1
[decide] signal=buy risk=465.75
[act] buy NQ mode=dry-run
[feedback] orderId=mock-order-<timestamp>

Done. runId=<uuid> status=succeeded
```

If run outside NYSE/CME Regular Trading Hours, the `rthSession` guard trips
and output will be:

```
Done. runId=<uuid> status=skipped
```

This is correct behaviour — the agent skips the cycle cleanly without calling
any phase functions (anti-pattern #8).

## What this demonstrates

### `withBrainContext` (orient phase)
Wraps the orient function to auto-fetch relevant Brain knowledge before the
phase runs. In this example, `fetchBrainContext` is mocked — no Brain server
needed. In production, inject a `BrainPort`-backed adapter.

### `redisCircuitBreaker` (risk guard)
Checks a Redis key (`cb:broker-api:tripped`) at the start of every cycle.
The circuit stays tripped until an explicit external reset — no TTL blind
expiry (anti-pattern #4). A mocked Redis client is injected for this example.

### `rthSession` (session guard)
Gates the cycle to NYSE/CME Regular Trading Hours: Mon-Fri 09:30-16:00 ET,
excluding CME holidays. Anti-pattern #5: checked every cycle, no caching.

### Anti-patterns covered

| # | Anti-pattern | Where in the code |
|---|---|---|
| 4 | No TTL on circuit breaker | `resetVia: "cron-rth"` in `redisCircuitBreaker` |
| 5 | Session guard every cycle | `sessionGuards: [rthSession()]` |
| 6 | `executionMode` required | `executionMode: "dry-run"` at construction |
| 7 | `observe`/`orient` readOnly | `readOnly: true` on both phases |
| 8 | Clean abort on guard trip | Cycle returns `status=skipped` — no phase calls |
| 9 | Resource limits configurable | `resourceLimits: { phaseTimeoutMs, maxStepsPerCycle, maxHeapMb }` |

## Next steps

- [03-replay-cycle/](../03-replay-cycle/) — live vs replay mode, `dryRunMocks`
