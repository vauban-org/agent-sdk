/**
 * evals/sprint-b-judges.ts
 *
 * LLM-judge annotation harness for Sprint B constitutional scoring evaluation.
 *
 * Two judges (deepseek-v4-pro + gemini-2.5-flash) each score every cycle on
 * all 5 Vauban axioms, producing a score in [0,1] and a rationale.
 *
 * Mock mode (BENCH_MODE=mock or --mode=mock): deterministic hash-based scores,
 * no API calls — safe for CI.
 *
 * Real mode: calls LiteLLM proxy (OpenAI-compatible /v1/chat/completions).
 * Endpoint:  LITELLM_URL  (default https://litellm.vauban.tech)
 * Auth key:  LITELLM_API_KEY
 *
 * @module evals/sprint-b-judges
 */

import type { AxiomId, CycleSnapshot } from "../src/constitution/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JudgeId = "deepseek-pro" | "deepseek-flash";

export interface JudgeAnnotation {
  runId: string;
  axiom: AxiomId;
  /** Normalised score in [0,1]. */
  score: number;
  /** Human-readable rationale from the judge. */
  rationale: string;
  judge: JudgeId;
}

// ---------------------------------------------------------------------------
// Axiom list (mirrors AxiomId union)
// ---------------------------------------------------------------------------

const ALL_AXIOMS: AxiomId[] = ["Institutionnel", "SOTA", "Robuste", "AntiFragile", "Profitable"];

// ---------------------------------------------------------------------------
// Model IDs for each judge (LiteLLM-side names)
// ---------------------------------------------------------------------------

const JUDGE_MODELS: Record<JudgeId, string> = {
  "deepseek-pro": "deepseek-v4-pro",
  "deepseek-flash": "deepseek-v4-flash",
};

// CAVEAT: both judges are from the DeepSeek family. Inter-judge κ measured here
// reflects intra-family consistency (Pro vs Flash size variants), not cross-family
// ensemble agreement. Founder-approved 2026-05-05 to bypass Institutionnel κ
// residual after Sprint B+1 (cross-family ensemble exposed irreducible LLM-prior
// disagreement on subjective regulatory axiom).

// ---------------------------------------------------------------------------
// Deterministic mock scorer — no API calls
// djb2 hash of (runId + axiom + judgeId) normalised to [0,1]
// ---------------------------------------------------------------------------

function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = (((hash << 5) + hash) ^ s.charCodeAt(i)) >>> 0;
  }
  return (hash >>> 0) / 0xffffffff;
}

function mockScore(runId: string, axiom: AxiomId, judge: JudgeId): number {
  const raw = djb2(`${runId}::${axiom}::${judge}`);
  if (runId.includes("-hi-")) {
    return 0.55 + raw * 0.45;
  }
  if (runId.includes("-lo-")) {
    return 0.05 + raw * 0.4;
  }
  return 0.25 + raw * 0.5;
}

function mockAnnotate(cycles: CycleSnapshot[], judges: JudgeId[]): JudgeAnnotation[] {
  const results: JudgeAnnotation[] = [];
  for (const cycle of cycles) {
    for (const axiom of ALL_AXIOMS) {
      for (const judge of judges) {
        const score = mockScore(cycle.runId, axiom, judge);
        results.push({
          runId: cycle.runId,
          axiom,
          score: Math.round(score * 100) / 100,
          rationale: `[mock] Deterministic score for ${cycle.runId} on ${axiom} by ${judge}: ${score.toFixed(3)}`,
          judge,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// System prompt — stable prefix
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a constitutional AI quality judge for the Vauban agent system.
Your task: evaluate a given agent CycleSnapshot against ONE specific axiom and return a JSON score.

The 5 Vauban axioms are:
1. Institutionnel: regulatory credibility, audit trail, PII handling, RSO compliance
2. SOTA: state-of-the-art model versions, ZK-friendly hash primitives, SLSA supply-chain level
3. Robuste: timeouts configured, explicit error paths, no secret leaks, scope declared
4. AntiFragile: fallback paths, multi-source redundancy, idempotent operations
5. Profitable: budget discipline, no overrun, cost tracking active

Scoring rules:
- Score 0.0 = severe violation (e.g. RSO veto, secret leak, 5× budget overrun)
- Score 0.25 = significant weakness (e.g. no fallback, stale model, no timeouts)
- Score 0.5 = neutral / insufficient signal
- Score 0.75 = mostly compliant with minor gaps
- Score 1.0 = fully satisfies the axiom

--- Institutionnel anchors ---
- 0.0: cycle stores raw email/IBAN/NIR in step.output with pii_redacted absent or false, AND no audit_trail_complete, AND rso_veto=true → severe multi-violation (GDPR + RSO breach).
- 0.5: pii_redacted=true and rootHash present (≥64 chars) but no regulatory_scope declared and audit_trail_complete missing → partial compliance, regulatory alignment unverifiable.
- 1.0: pii_redacted=true + regulatory_scope ∈ {eIDAS, gdpr, ai-act-art-14} + audit_trail_complete=true + rootHash present (≥64 chars) + no PII pattern (email/IBAN/NIR/phone FR) in any step.output → full institutional satisfaction.

--- SOTA anchors ---
- 0.0: step uses gpt-3 or gpt-3.5 or claude-1 or claude-2 (known-stale) AND hash_primitive is md5 or sha1 AND slsa_level < 2 → severe SOTA regression.
- 0.5: model is recent (not stale) but hash_primitive is keccak256 (ZK-unsafe) or sha256 (acceptable, not ZK-optimal) and slsa_level=2 → acceptable model, suboptimal ZK + supply-chain.
- 1.0: model is recent (not in stale list) AND hash_primitive is poseidon (ZK-friendly) AND slsa_level ≥ 3 → full SOTA satisfaction.

--- AntiFragile anchors ---
- 0.0: has_fallback=false AND is_idempotent=false AND source_count=1 → single point of failure, no recovery path, non-idempotent — fully fragile.
- 0.5: has_fallback=true but source_count=1 AND is_idempotent=false → partial resilience (fallback exists but single source and non-idempotent).
- 1.0: has_fallback=true AND source_count ≥ 2 AND is_idempotent=true → fully anti-fragile with redundancy and recovery guarantees.

Return ONLY valid JSON: {"score": <float 0-1>, "rationale": "<1-2 sentences>"}
No markdown, no explanation outside the JSON object.`;

// ---------------------------------------------------------------------------
// LiteLLM transport (OpenAI-compatible /v1/chat/completions)
// ---------------------------------------------------------------------------

interface LiteLLMResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
}

async function callLiteLLM(
  url: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`LiteLLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as LiteLLMResponse;
  const msg = data.choices?.[0]?.message;
  return msg?.content || "";
}

function extractJson(raw: string): { score: number; rationale: string } {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) candidates.push(objMatch[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as { score: number; rationale: string };
      const score = Math.min(1, Math.max(0, Number(parsed.score)));
      if (Number.isFinite(score)) {
        return { score, rationale: String(parsed.rationale ?? "") };
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(`Cannot parse JSON from response: ${raw.slice(0, 200)}`);
}

async function callJudgeWithRetry(
  url: string,
  apiKey: string,
  model: string,
  cycle: CycleSnapshot,
  axiom: AxiomId,
): Promise<{ score: number; rationale: string }> {
  const userContent = `Axiom to evaluate: ${axiom}

CycleSnapshot:
${JSON.stringify(cycle, null, 2)}

Return JSON only: {"score": <0-1>, "rationale": "<1-2 sentences>"}`;

  const callOnce = async () => {
    // DeepSeek-v4-pro emits long reasoning_content before final content.
    // Allocate enough max_tokens for both reasoning + answer.
    const maxTokens = model.includes("deepseek") ? 2048 : 512;
    const raw = await callLiteLLM(url, apiKey, model, SYSTEM_PROMPT, userContent, maxTokens);
    return extractJson(raw);
  };

  try {
    return await callOnce();
  } catch {
    try {
      return await callOnce();
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return {
        score: -1, // sentinel: missing annotation
        rationale: `[error] Judge call failed after 2 attempts: ${msg}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function annotateWithJudges(
  cycles: CycleSnapshot[],
  judges: JudgeId[],
  options?: { mode?: "mock" | "real"; concurrency?: number },
): Promise<JudgeAnnotation[]> {
  const mode =
    options?.mode ??
    (process.env["BENCH_MODE"] === "mock" || process.argv.includes("--mode=mock")
      ? "mock"
      : "real");

  if (mode === "mock") {
    return mockAnnotate(cycles, judges);
  }

  const url = process.env["LITELLM_URL"] || "https://litellm.vauban.tech";
  const apiKey = process.env["LITELLM_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "LITELLM_API_KEY not set — cannot run real-LLM annotation. " +
        "Decode SOPS: vauban-infrastructure/sops/ai-platform/litellm-secrets.enc.yaml MASTER_KEY (base64).",
    );
  }

  const concurrency = Math.max(1, options?.concurrency ?? 4);
  const tasks: Array<{ cycle: CycleSnapshot; axiom: AxiomId; judge: JudgeId }> = [];
  for (const judge of judges) {
    for (const cycle of cycles) {
      for (const axiom of ALL_AXIOMS) {
        tasks.push({ cycle, axiom, judge });
      }
    }
  }

  const results: JudgeAnnotation[] = new Array(tasks.length);
  let cursor = 0;
  let completed = 0;
  const total = tasks.length;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const { cycle, axiom, judge } = tasks[idx];
      const model = JUDGE_MODELS[judge];
      const { score, rationale } = await callJudgeWithRetry(url, apiKey, model, cycle, axiom);
      results[idx] = { runId: cycle.runId, axiom, score, rationale, judge };
      completed++;
      if (completed % 10 === 0 || completed === total) {
        // eslint-disable-next-line no-console
        console.log(`[judges] ${completed}/${total} (${judge}/${axiom}/${cycle.runId})`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Convenience: load mock annotations from the pre-computed JSON dataset.
 * Falls back to generating them if the file does not exist.
 */
export async function loadOrGenerateMockAnnotations(
  cycles: CycleSnapshot[],
  mockFilePath: string,
): Promise<JudgeAnnotation[]> {
  try {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(mockFilePath, "utf8");
    return JSON.parse(raw) as JudgeAnnotation[];
  } catch {
    return mockAnnotate(cycles, ["deepseek-pro", "deepseek-flash"]);
  }
}
