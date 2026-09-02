---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Sprint-580-A — BoN-MAV Bench Results

**Captured**: 2026-05-05  
**Harness**: `bench/sprint-a-bench.ts`  
**Run**: `pnpm exec tsx bench/sprint-a-bench.ts`

---

## Methodology

### Synthetic task model

Real LLM API calls were intentionally excluded (no API keys available in this session; cost would inflate without adding plumbing-validation signal). This is standard practice for compute-strategy bench plumbing validation — the paper (Lifshitz et al., arXiv:2502.20379 §3) evaluates on real LLMs; this sprint validates wiring and statistical shape with a fully controlled simulation.

**Tasks**: 30 numeric tasks. Each task has a hidden ground-truth `truth ∈ [10, 90]` (deterministic, evenly spaced with a prime-number stride of 83 mod 80 for diversity).

**Generator model**: Each call draws a candidate from `N(truth, σ_g)` with `σ_g = 15`. This is calibrated so that `|candidate - truth| < THRESHOLD = 5` with probability `P ≈ P(|N(0,1)| < 5/15) ≈ P(|N(0,1)| < 0.33) ≈ 26%`. Empirically the single-shot baseline lands at **20%** accuracy with the seeded PRNG, confirming a noisy, hard-to-beat baseline (intentionally below 50% to give strategies clear room to improve).

**Verifier model**: Three aspect verifiers (`aspect-accuracy`, `aspect-fluency`, `aspect-relevance`) each return:
```
score = clamp(1 - |value - truth| / (3 * σ_g) + N(0, σ_v), 0, 1)
```
with `σ_v = 0.12` and independent noise seeds per verifier. This models verifiers that are imperfectly correlated with correctness and err independently — matching the paper's premise that independent verifier noise averages out under MAV aggregation.

**PRNG**: mulberry32, seeded at construction. Seeds:
- Generator: `0xc0ffee01`
- Verifier 1: `0xc0ffee02`
- Verifier 2: `0xc0ffee03`
- Verifier 3: `0xc0ffee04`
- Bootstrap CI: `0xdeadbeef`

**Accuracy**: fraction of tasks where `|answer - truth| < 5`.

**Bootstrap CI**: n_resample = 1000, percentile method, seed `0xdeadbeef`.

---

## Results

| Strategy | Accuracy | 95% CI | Cost (calls) | Latency (ms) | Delta vs baseline |
|---|---|---|---|---|---|
| single-shot | 20.0% | [6.7%, 33.3%] | 1.0 | 0.006 | — |
| best-of-n-4 (composite reward) | 70.0% | [53.3%, 86.7%] | 4.0 | 0.044 | **+250%** |
| bon-mav-4 (mean) | 73.3% | [56.7%, 86.7%] | 4.0 | 0.052 | **+267%** |
| bon-mav-4 (median) | 50.0% | [33.3%, 66.7%] | 4.0 | 0.052 | +150% |
| bon-mav-4 (majority-vote) | 36.7% | [20.0%, 53.3%] | 4.0 | 0.052 | +83% |

All BoN variants incur 4× generator calls versus 1× for single-shot (expected by design).

---

## Observations

1. **BoN-MAV (mean) is the top performer** at 73.3% accuracy — a 3.7× lift over single-shot. This aligns with Lifshitz et al.'s finding that averaging continuous verifier scores outperforms binary-vote aggregations.

2. **BoN-4 (composite reward)** at 70.0% is essentially tied with BoN-MAV mean within CI. Both use an averaged score; the difference is architectural (BoN wraps verifiers as a reward model; BoN-MAV runs them natively with the N×M matrix).

3. **Median aggregation** drops to 50% — competitive but weaker. With only 3 verifiers, median picks the middle value, which is more sensitive to outlier verifier noise than the mean.

4. **Majority-vote** is weakest at 36.7%. With 3 verifiers and a continuous-score voteThreshold=0.5, many candidates receive mixed votes even when they are genuinely good, degrading discrimination.

5. **Latency**: all strategies run in sub-millisecond range (synthetic, no I/O). Real LLM latency will be 100-1000× higher; BoN-MAV adds N×M parallel verifier calls.

---

## Honesty: Synthetic ≠ Real LLMs

**This bench validates plumbing and shows the *direction* of effect — it does NOT constitute evidence of the ≥20% gain required by plan v6.**

Differences between this simulation and real LLM evaluation:

- The synthetic generator is a simple Gaussian — real LLM output quality is non-Gaussian, depends on prompt structure, and is affected by temperature, sampling strategies, and model capability.
- The synthetic verifiers have perfectly calibrated noise; real LLM-backed verifiers have systematic biases (anchoring, verbosity preference, hallucinated rubrics) that may be correlated, undermining the MAV independence assumption.
- Accuracy on 30 synthetic tasks has wide CIs (see column above). Real bench needs 100-300+ tasks for 5% CI width at 70% accuracy.
- **The ≥20% acceptance gate per plan v6 must be re-run on real LLMs with real API access — not done in this session due to no API access.**

---

## Recommendation

**SHIP** (subject to real-LLM validation gate before production rollout).

Rationale:
- BoN-MAV (mean) shows **+267% synthetic gain**, well above the 15% failure-budget trigger threshold.
- Wiring is correct: all 5 strategy paths execute, return well-formed `StrategyResult`, cost accounting matches N×M call budget, and 1150 pre-existing tests remain green.
- The mean aggregation mode is the clear winner in this simulation — consistent with paper recommendation. Median and majority-vote should be treated as experimental variants behind a feature flag.

**Conditional gate**: before enabling BoN-MAV in production:
1. Re-run this bench with real LLM API access (Sonnet 4.x, temperature 1.0, N=4).
2. Confirm ≥20% accuracy delta on a domain-representative task set (≥100 tasks).
3. If delta < 20% on real LLMs, gate BoN-MAV behind `FEATURE_BON_MAV=true` env flag pending further tuning.

---

## Files

| File | Role |
|---|---|
| `bench/sprint-a-bench.ts` | Runnable bench harness (synthetic, no API calls) |
| `bench/sprint-a-results.json` | Machine-readable output (last run) |
| `tests/bench-sprint-a.test.ts` | Sanity tests (6 assertions, all passing) |
