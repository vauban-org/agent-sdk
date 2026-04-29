# Replay Cycle — live vs replay mode

Demonstrates the V7-2 critical pattern: every skill and phase must check
`ctx.isReplay` and skip observable side effects when true. The same agent
is triggered twice — once in live mode, once in replay mode — producing
structurally identical outputs.

## Run

```bash
cd examples/03-replay-cycle
npm install @vauban/agent-sdk starknet@6
node index.mjs
```

## Expected output

```
=== Cycle 1: live mode (dryRun=false, isReplay=false) ===
[observe] LIVE — fetched quote from live
[orient] LIVE price=21500 regime=above-avg
[decide] LIVE action=hold
[act] LIVE — action=hold (dry-run: no real order)
[feedback] LIVE sent=true
status=succeeded runId=<uuid>

=== Cycle 2: replay mode (dryRun=true, isReplay=true) ===
[observe] REPLAY — returning mock quote
[orient] REPLAY price=21000 regime=below-avg
[decide] REPLAY action=watch
[act] REPLAY — skipping side effects
[feedback] REPLAY sent=false
status=succeeded runId=<uuid>
```

## What this demonstrates

### V7-2 replay pattern

When `ctx.isReplay === true`:
- Skills return deterministic mock data from `dryRunMocks` (or inline fixtures)
- No HTTP calls, no Slack notifications, no broker orders, no Brain writes
- Phase logic still executes — only the I/O boundary is guarded

The pattern is:

```javascript
fn: async (_input, ctx) => {
  if (ctx.isReplay) {
    return MOCK_DATA;  // deterministic, no side effect
  }
  return await fetchLiveData();  // real I/O only in live mode
}
```

### When is this useful?

- **Audit replay**: re-run a historical cycle from stored inputs to verify
  the agent would make the same decision today
- **Testing**: trigger a cycle in CI without any external dependencies
- **Debugging**: isolate a failing cycle by replaying it with known inputs

### `triggerCycle({ dryRun: true })` vs `executionMode: "dry-run"`

- `executionMode: "dry-run"` at construction: the whole agent is in dry-run
  for all cycles, including `start()` loops
- `triggerCycle({ dryRun: true })`: overrides to dry-run for that single
  one-shot trigger only — the agent's `executionMode` is not mutated

Both set `ctx.isReplay = true` inside the cycle context.

## Next steps

- Read [CONTRACT.md](../../CONTRACT.md) for the full public API surface
- Check [VERIFICATION.md](../../VERIFICATION.md) for supply-chain signature verification
- See [vauban-verify on PyPI](https://pypi.org/project/vauban-verify/) for offline run certificate verification
