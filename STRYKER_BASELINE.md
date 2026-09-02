---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Stryker Mutation Baseline — @vauban-org/agent-sdk

## Sprint-469 — 2026-04-28

### Dry-Run Findings

Full mutation run not executed (estimated 30+ hours with concurrency=2 — not viable locally).
Dry run completed successfully: **493 tests in 52s**, plugin resolution confirmed.

| Metric | Value |
|--------|-------|
| Source files mutated | 86 of 629 |
| Total mutants generated | 5,180 |
| Static mutants | ~388 (7%) — estimated 94% of runtime |
| Non-static mutants (with `ignoreStatic`) | ~4,792 |
| Test suite | 493 tests, 52s dry-run |
| Estimated run time (concurrency=2, no ignoreStatic) | ~31h |
| Estimated run time (concurrency=2, ignoreStatic=true) | ~2-4h |

### Why No Score Yet

The agent-sdk is a large package (86 mutable files, 5180 mutants). A full run requires:
- Either: CI runners with high concurrency (8-16 workers, ~1h)
- Or: incremental mode after first run (fast subsequent runs)
- Or: scoped run on a single module (e.g. `--mutate "src/budget/**/*.ts"`)

The `ignoreStatic: true` flag is set in `stryker.conf.mjs` to reduce runtime by ~94%.
First real baseline will be captured on CI (GitHub Actions, ubuntu-latest, 30min timeout).

### Expected Score Estimate

Based on test coverage patterns:
- Budget/quota modules: well-tested via property tests → estimated 75-85%
- Permission/auth modules: integration tests → estimated 65-75%
- Routing/circuit-breaker: unit tests → estimated 70-80%
- Proof/ZK modules: light tests → estimated 50-65%

**Estimated overall baseline: 60-70%** (below the 80% high threshold).

### Path to 80%

1. **Phase 1 — Identify survivors** (after first CI run): `reports/mutation/mutation.html` shows survived mutants per file.
2. **Phase 2 — Target blind spots** (~sprint task):
   - Add boundary tests for numerical comparisons (common survivor: off-by-one `<` → `<=`)
   - Add tests for error branch conditions (common survivor: truthy → falsy flips)
   - Strengthen budget guard edge cases (0 budget, max budget, overflow)
3. **Phase 3 — Enforce threshold** (sprint after baseline): set `break: 70` → `break: 80` in `stryker.conf.mjs` once above 80%.

### Commands

```bash
# Quick dry run (verify setup, ~1min)
pnpm -F @vauban-org/agent-sdk mutation -- --dryRunOnly

# Full baseline (CI recommended, ~1-4h with ignoreStatic)
pnpm -F @vauban-org/agent-sdk stryker

# Scoped run (fast, single module)
pnpm -F @vauban-org/agent-sdk mutation -- --mutate "src/budget/**/*.ts"

# Force full run including static mutants (~30h local)
pnpm -F @vauban-org/agent-sdk mutation -- --force --no-ignoreStatic
```

### Config Reference

- Config: `packages/agent-sdk/stryker.conf.mjs`
- HTML report output: `packages/agent-sdk/reports/mutation/mutation.html`
- CI workflow: `.github/workflows/mutation-score.yml` (matrix: agent-sdk, agent-sources, forecast-utils)
- CI schedule: Sunday 04:00 UTC + PR trigger on `packages/**`
