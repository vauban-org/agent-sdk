# Hello World — minimal OODA agent

The simplest possible agent: one dry-run cycle through all five OODA phases,
no API keys, no backend, exits 0 on success.

## Run

```bash
cd examples/01-hello-world
npm install @vauban/agent-sdk starknet@6
node index.mjs
```

## Expected output

```
[observe] cycle=0 mode=dry-run
[orient] observed value=42 at 2026-04-28T14:30:00.000Z
[decide] trend=high
[act] action=alert replay=false
[feedback] dispatched=alert

Done. runId=<uuid> status=succeeded
```

## What this demonstrates

- `createOODAAgent` — the single factory for all OODA agents
- `executionMode: "dry-run"` — required field, no implicit default (anti-pattern #6)
- Five typed phases: `observe → orient → decide → act → feedback`
- `readOnly: true` on `observe` and `orient` — enforced by the SDK constructor
- `triggerCycle({ dryRun: true })` — one-shot execution without starting the loop
- `noopLogger` — default in SDK 0.8.1+, no logger injection needed

## Next steps

- [02-trading-agent/](../02-trading-agent/) — circuit breaker, RTH session guard, Brain context mock
- [03-replay-cycle/](../03-replay-cycle/) — live vs replay mode, `dryRunMocks`
