---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Sprint B Bench — Constitutional Scorer Correlation

Generated: 2026-05-05T17:45:37.239Z
Mode: **real**
Overall: **PASSED** — all axioms meet ρ≥0.5 and κ≥0.6 thresholds.

## Results Table

| Axiom          | Spearman ρ | Cohen κ | ρ gate | κ gate |
|----------------|-----------|---------|--------|--------|
| Institutionnel | 0.766 | 0.691 | ✓ (ρ≥0.5) | ✓ (κ≥0.6) |
| SOTA           | 0.816 | 0.956 | ✓ (ρ≥0.5) | ✓ (κ≥0.6) |
| Robuste        | 0.970 | 0.983 | ✓ (ρ≥0.5) | ✓ (κ≥0.6) |
| AntiFragile    | 0.930 | 0.983 | ✓ (ρ≥0.5) | ✓ (κ≥0.6) |
| Profitable     | 0.999 | 1.000 | ✓ (ρ≥0.5) | ✓ (κ≥0.6) |

## Interpretation

- **Spearman ρ**: correlation between built-in scorer and LLM-judge mean. Target: ρ ≥ 0.5 per axiom.
- **Cohen κ**: inter-judge agreement (deepseek-v4-pro vs deepseek-v4-flash), ordinal quadratic-weighted 3-bin (low/mid/high). Target: κ ≥ 0.6 per axiom.
- Dataset: 30 synthetic CycleSnapshots (6 per axiom, 3 high + 3 low quality).
- Judges: deepseek-v4-pro + deepseek-v4-flash via LiteLLM proxy (300 calls per full real-LLM run).

## Rationale Samples

### Institutionnel
- [deepseek-pro] All Institutionnel requirements are met: PII redacted, audit trail complete, eIDAS regulatory scope 
- [deepseek-pro] Cycle fully satisfies the Institutionnel axiom: pii_redacted=true, regulatory_scope='gdpr', audit_tr

### SOTA
- [deepseek-pro] Model is recent (claude-opus-4-7 not in stale list), hash primitive is Poseidon (ZK-friendly), and S
- [deepseek-pro] Model is recent and SLSA level is 4, but hash primitive is sha256 instead of poseidon, a minor gap f

### Robuste
- [deepseek-pro] All Robuste criteria satisfied: timeouts_configured=true, error_paths_explicit=true, scope declared 
- [deepseek-pro] All robustness indicators present: timeouts_configured=true, error_paths_explicit=true, no secret le

### AntiFragile
- [deepseek-pro] has_fallback=true, source_count=2, and is_idempotent=true meet all AntiFragile requirements for redu
- [deepseek-pro] The snapshot has fallback enabled, idempotent operations, and source_count=3, fully satisfying AntiF

### Profitable
- [deepseek-pro] Total spend $0.021 is well within budget $0.10 (no overrun), and cost tracking is explicitly recorde
- [deepseek-pro] Total spent ($0.027) is well under the budget max ($0.15), and cost per step is tracked, ensuring bu

## CAVEAT: Mock vs Real Mode

This report was generated in **real mode**.

### Mock mode
- Scores are deterministic (djb2 hash of runId + axiom + judge).
- Biased toward expected quality: hi-cycles → [0.55,1.0], lo-cycles → [0.05,0.45].
- No API calls. Safe for CI. Validates bench mechanics only.
- Spearman/κ values are artifacts of the mock hash distribution, NOT real scorer correlation.

### Real mode
- Requires `LITELLM_URL` (default https://litellm.vauban.tech) + `LITELLM_API_KEY` in environment.
- Judges: `deepseek-v4-pro` + `gemini-2.5-flash` via LiteLLM proxy. 300 calls (30 cycles × 5 axioms × 2 judges).
- Estimated cost: ~$1–3 for one full pass (DeepSeek pricing).
- Run: `LITELLM_API_KEY=... pnpm tsx evals/sprint-b-bench.ts --mode=real`
- Real results overwrite `bench/sprint-b-results.md`.

### Next steps for re-bench
1. Set `LITELLM_API_KEY` (decode SOPS `vauban-infrastructure/sops/ai-platform/litellm-secrets.enc.yaml` → MASTER_KEY base64).
2. Run: `pnpm tsx evals/sprint-b-bench.ts --mode=real`
3. Human spot-check 5/30 cycles (founder task, left as TODO per spec).
