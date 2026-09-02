/**
 * Multi-Agent Debate — Dual LLM in orient/decide phases.
 *
 * Pattern: Strategist (thesis) + Skeptic (antithesis) → Synthesizer → synthesis.
 *
 * The debate engine runs two adversarial LLM stances against each other
 * and produces a consensus score + plan. Used for high-stakes decisions
 * where a single LLM's blind spots are unacceptable (legal review,
 * financial allocation, security decisions).
 *
 * Reference: command-center/docs/specs/debate-engine-spec.md
 *
 * @public
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface DebateStance {
  /** The argument / position. */
  content: string;
  /** Confidence score (0.0 - 1.0). */
  confidence: number;
  /** Key points supporting this stance. */
  keyPoints: string[];
  /** Identified risks or weaknesses. */
  risks: string[];
}

/** @public */
export interface DebateSynthesis {
  /** Synthesized conclusion. */
  conclusion: string;
  /** Consensus score (0.0 = total disagreement, 1.0 = full agreement). */
  consensusScore: number;
  /** Recommended action. */
  recommendation: string;
  /** Key trade-offs identified. */
  tradeoffs: string[];
  /** Whether HITL escalation is recommended. */
  hitlRecommended: boolean;
}

/** @public */
export interface DebateResult {
  thesis: DebateStance;
  antithesis: DebateStance;
  synthesis: DebateSynthesis;
  /** Number of debate rounds. */
  rounds: number;
}

/** @public */
export interface DebateConfig {
  /** The question or decision to debate. */
  question: string;
  /** Context / background information. */
  context?: string;
  /** Max debate rounds (default: 1). */
  maxRounds?: number;
  /** LLM function for the strategist (thesis). */
  strategist: (question: string, context?: string) => Promise<DebateStance>;
  /** LLM function for the skeptic (antithesis). */
  skeptic: (question: string, thesis: DebateStance, context?: string) => Promise<DebateStance>;
  /** LLM function for the synthesizer. */
  synthesizer: (
    question: string,
    thesis: DebateStance,
    antithesis: DebateStance,
    context?: string,
  ) => Promise<DebateSynthesis>;
}

// ─── Engine ─────────────────────────────────────────────────────────────────────

/**
 * Run a multi-agent debate.
 *
 * 1. Strategist proposes thesis
 * 2. Skeptic challenges with antithesis
 * 3. Synthesizer merges into consensus + recommendation
 *
 * If `maxRounds > 1`, the thesis and antithesis are fed back for refinement.
 * @public
 */
export async function runDebate(config: DebateConfig): Promise<DebateResult> {
  const maxRounds = config.maxRounds ?? 1;

  let thesis = await config.strategist(config.question, config.context);
  let antithesis = await config.skeptic(config.question, thesis, config.context);

  // Multi-round refinement
  for (let round = 1; round < maxRounds; round++) {
    // Refine thesis against antithesis
    thesis = await config.strategist(
      `${config.question}\n\nCounterarguments to address:\n${antithesis.content}`,
      config.context,
    );
    // Refine antithesis against refined thesis
    antithesis = await config.skeptic(
      `${config.question}\n\nUpdated thesis to challenge:\n${thesis.content}`,
      thesis,
      config.context,
    );
  }

  const synthesis = await config.synthesizer(config.question, thesis, antithesis, config.context);

  return { thesis, antithesis, synthesis, rounds: maxRounds };
}
