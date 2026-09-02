---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# BoN-MAV — Multi-Agent Verification (Lifshitz et al. 2025)

**Source**: Lifshitz et al., "Multi-Agent Verification: Scaling Test-Time Compute with Multiple Verifiers", arXiv:2502.20379 (v2, 2025).

## Algorithm (paper § 2.3)

BoN-MAV is a three-step Best-of-N procedure with multiple **Aspect Verifiers (AVs)**:

1. Sample `n` candidate outputs `o^(1), ..., o^(n)` from a generator LLM.
2. For each candidate, collect **binary approvals** `BinaryScore_v(o^(i)) ∈ {0,1}` from each of `m` aspect verifiers `v ∈ M`. An aspect verifier is an off-the-shelf LLM prompted to check ONE specific aspect (correctness, units, format, edge cases, ...).
3. Select `î = argmax_i AggScore(o^(i))` and return `o^(î)`.

The aggregation function (§ 2.2, Eq. 1) is an unweighted average of the binary verifier votes:

> `AggScore(o^(i)) = (1/|M|) · Σ_{v ∈ M} BinaryScore_v(o^(i))`

This is functionally **majority vote with equal weights** — the paper notes more sophisticated aggregation is left to future work. Notation: `BoN-MAV@n` denotes `n` candidates, `|M|` denotes the verifier-count axis. The framework scales independently along both axes (`n`, `m`).

## Aggregation strategies (this implementation)

The Vauban implementation generalizes the paper's binary-vote average to four aggregation modes — the paper baseline (`majority-vote` with `voteThreshold=0.5`) is preserved bit-exact, while `mean`/`median`/`min` are extensions for verifiers that emit continuous `[0,1]` scores (our `Verifier` interface, `src/compute/verifier.ts`):

- `mean` — paper-equivalent on continuous scores (default; matches Eq. 1 generalized).
- `median` — robust to a single outlier verifier.
- `min` — conservative / worst-case (useful for safety-critical aspects).
- `majority-vote` — paper-faithful: each score `≥ voteThreshold` counts as `1`, aggregated as `votes/M`.

## Empirical findings (paper § 3.1, Fig. 5, Table 1)

Tested on MATH, MMLU-Pro, GPQA-diamond, HumanEval with `n=16`. BoN-MAV outperforms self-consistency and reward-model verification, with **up to ~10% gain on large LLMs and ~20% on small ones** as `m` grows. Demonstrates **weak-to-strong generalization**: weaker verifier ensembles can supervise stronger generators.

The bench harness (sibling task in Sprint A) targets the ≥20% accuracy delta on the small-model regime, which is consistent with Fig. 5's small-LLM curve.

## Cost accounting note

Paper assumes verifier calls are "free" relative to generator calls in the compute budget. Our `cost.calls = N` mirrors this: only generator calls counted. Verifier-call cost is exposed implicitly via `mavMatrix.length × mavMatrix[0].length` in metadata for downstream telemetry.
