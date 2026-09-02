/**
 * src/compute/difficulty-estimator.ts
 *
 * Deterministic task-difficulty classifier + strategy recommender.
 *
 * NOT an LLM call — pure feature extraction + rule-based classification.
 * Routes input difficulty → recommended compute strategy.
 *
 * @experimental Public-experimental API per `contract-stability.md` (sprint-582).
 * @public
 */

// ─── Public types ────────────────────────────────────────────────────────────

export type DifficultyClass = "simple" | "standard" | "complex" | "reasoning";

/** @public */
export interface TaskFeatures {
  /** Character count of input. */
  inputLength: number;
  /** Input contains "step", "then", or "first…then" pattern. */
  hasMultipleSteps: boolean;
  /** Input contains "why", "explain", "reason", "prove", "deduce". */
  requiresReasoning: boolean;
  /** Input contains "create", "generate", "design", "imagine". */
  requiresCreativity: boolean;
  /** Input contains digits or math operators. */
  hasNumerics: boolean;
  /** Input references multiple entities ("A and B", "compare"). */
  hasCrossReference: boolean;
  /** Length of optional context/system prompt. */
  contextLength: number;
}

// ─── Regex patterns (case-insensitive, word-bounded where useful) ───────────

const RE_STEPS = /\b(step|steps|then|first|next|finally)\b/i;
const RE_REASONING =
  /\b(why|explain|explains|reason|reasons|prove|proves|deduce|deduces|infer|justify)\b/i;
const RE_CREATIVITY = /\b(create|generate|design|imagine|invent|compose)\b/i;
const RE_NUMERICS = /[0-9]|[+\-*/^=]/;
const RE_CROSS_REF = /\b(compare|and|versus|vs\.?|both)\b/i;

// ─── Feature extraction ──────────────────────────────────────────────────────

/**
 * Extract task features from input + optional context.
 * Deterministic, side-effect free.
 * @public
 */
export function extractFeatures(input: string, context?: string): TaskFeatures {
  const inputLength = input.length;
  const contextLength = context?.length ?? 0;

  return {
    inputLength,
    hasMultipleSteps: RE_STEPS.test(input),
    requiresReasoning: RE_REASONING.test(input),
    requiresCreativity: RE_CREATIVITY.test(input),
    hasNumerics: RE_NUMERICS.test(input),
    hasCrossReference: RE_CROSS_REF.test(input),
    contextLength,
  };
}

// ─── Difficulty classification ───────────────────────────────────────────────

/**
 * Classify difficulty from task features.
 *
 * Decision tree (most specific first):
 *   - requiresReasoning → "reasoning"
 *   - inputLength > 500 OR hasMultipleSteps OR requiresCreativity → "complex"
 *   - inputLength in [100, 500] OR hasNumerics → "standard"
 *   - else → "simple"
 * @public
 */
export function estimateDifficulty(features: TaskFeatures): DifficultyClass {
  if (features.requiresReasoning) return "reasoning";
  if (features.inputLength > 500 || features.hasMultipleSteps || features.requiresCreativity) {
    return "complex";
  }
  if (features.inputLength >= 100 || features.hasNumerics) {
    return "standard";
  }
  return "simple";
}

// ─── Strategy recommendation ─────────────────────────────────────────────────

/**
 * Recommend a compute strategy for a given difficulty class.
 *
 * Map (per Sprint A bench results + Sprint-582 spec):
 *   simple     → single-shot
 *   standard   → bon-mav
 *   complex    → tree-of-thoughts
 *   reasoning  → mixture-of-agents
 * @public
 */
export function recommendStrategy(difficulty: DifficultyClass): string {
  switch (difficulty) {
    case "simple":
      return "single-shot";
    case "standard":
      return "bon-mav";
    case "complex":
      return "tree-of-thoughts";
    case "reasoning":
      return "mixture-of-agents";
    default: {
      const _exhaustive: never = difficulty;
      throw new Error(`recommendStrategy: unknown difficulty "${String(_exhaustive)}"`);
    }
  }
}
