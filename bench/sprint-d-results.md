---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
note: "To regenerate this file, run: BENCH_WRITE_RESULTS=1 pnpm vitest run (or pnpm tsx bench/sprint-d-bench.ts). Plain pnpm vitest run skips the write to prevent accidental overwrites."
---
# Sprint-584 Bench Results — DeepSeek Baseline Cost Reduction

Generated: 2026-07-05T15:15:57.407Z
Seed: 42 (deterministic LCG)

## Summary

| Metric | Value |
|--------|-------|
| Cycles | 100 |
| Baseline total (all premium) | $0.111916 |
| Router total | $0.062796 |
| Cost reduction | **43.89 %** |
| Acceptance gate | ≥ 10 % |
| Verdict | **PASS** |

**Recommendation**: EconomyRouter delivers ≥10 % cost reduction. Ship router.

## Category Breakdown

| Category | Cycles | Baseline total | Router total | Reduction % |
|----------|--------|----------------|--------------|-------------|
| simple | 25 | $0.028730 | $0.007251 | 74.76 % |
| standard | 25 | $0.026920 | $0.000169 | 99.37 % |
| complex | 25 | $0.028439 | $0.027549 | 3.13 % |
| reasoning | 25 | $0.027827 | $0.027827 | 0.00 % |

## Tier Distribution (Router)

| Tier | Cycles |
|------|--------|
| free | 1 |
| cheap | 25 |
| mid | 25 |
| premium | 49 |

## Pricing Used

| Model | In ($/M) | Out ($/M) | Tier |
|-------|----------|-----------|------|
| deepseek-v4-pro | 0.27 | 1.10 | premium |
| deepseek-v4-flash | 0.07 | 0.28 | cheap |
| llama-3.3-70b-versatile (Groq) | 0.00 | 0.00 | mid |
| default-fast (LiteLLM/Qwen3-8B) | 0.00 | 0.00 | free |

## Methodology

- 100 synthetic cycles, 25 per category (simple / standard / complex / reasoning).
- inputTokens ~ Uniform[500, 4000], outputTokens ~ Uniform[100, 800].
- Deterministic LCG PRNG, seed=42 — 100 % reproducible.
- Baseline: all cycles to `deepseek-v4-pro` (premium).
- Router: `EconomyRouter` + `DefaultTierPolicy` in `degraded` mode (no prior history → policy defaults).
- Circuit breaker threshold set to $1,000,000 to prevent trips during bench.
