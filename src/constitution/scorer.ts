/**
 * src/constitution/scorer.ts
 *
 * Constitutional scoring — one ScoringFunction per axiom.
 * Each scorer aggregates SignalPoints from its axiom and normalises to [0, 1].
 *
 * Custom scorers can be registered via the ScorerRegistry.
 *
 * @module constitution/scorer
 */

import {
  ANTI_FRAGILE,
  type Axiom,
  BUILT_IN_AXIOMS,
  INSTITUTIONNEL,
  PROFITABLE,
  ROBUSTE,
  SOTA,
} from "./axioms.js";
import type { AxiomId, CycleSnapshot, SignalPoint } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** @public */
export interface ScoringResult {
  /** Normalised score in [0, 1]. */
  score: number;
  /** Human-readable rationale for audit. */
  rationale: string;
  /** The raw signal points used to produce this score. */
  signals: SignalPoint[];
}

/**
 * A function that takes a CycleSnapshot and returns a scored result.
 * May be async to allow future LLM-graded scorers.
 * @public
 */
export type ScoringFunction = (cycle: CycleSnapshot) => Promise<ScoringResult>;

// ---------------------------------------------------------------------------
// Core scoring logic — shared by all built-in scorers
// ---------------------------------------------------------------------------

/**
 * Aggregate SignalPoints into a normalised [0, 1] score.
 *
 * Algorithm:
 *   raw = Σ(weight_i) / Σ(|weight_i|)   (weighted average in [−1, 1])
 *   score = (raw + 1) / 2                (shift to [0, 1])
 *
 * When no signals are present, returns 0.5 (neutral).
 */
function aggregateSignals(signals: SignalPoint[]): number {
  if (signals.length === 0) return 0.5;

  const sumWeights = signals.reduce((acc, s) => acc + s.weight, 0);
  const sumAbsWeights = signals.reduce((acc, s) => acc + Math.abs(s.weight), 0);

  if (sumAbsWeights === 0) return 0.5;

  const raw = sumWeights / sumAbsWeights; // in [−1, 1]
  return (raw + 1) / 2; // in [0, 1]
}

/**
 * Build a rationale string from signals for audit output.
 */
function buildRationale(axiomId: AxiomId, score: number, signals: SignalPoint[]): string {
  const lines = signals.map(
    (s) => `  [${s.weight > 0 ? "+" : ""}${s.weight.toFixed(2)}] ${s.label}: ${s.evidence}`,
  );
  return [`${axiomId} score=${score.toFixed(3)}`, ...lines].join("\n");
}

/**
 * Factory — creates a ScoringFunction for a given Axiom.
 */
function axiomScorer(axiom: Axiom): ScoringFunction {
  return async (cycle: CycleSnapshot): Promise<ScoringResult> => {
    const signals = axiom.detect(cycle);
    const score = aggregateSignals(signals);
    const rationale = buildRationale(axiom.id, score, signals);
    return { score, rationale, signals };
  };
}

// ---------------------------------------------------------------------------
// Built-in scorers
// ---------------------------------------------------------------------------

/**
 * Scorer for the Institutionnel axiom.
 * @public
 */
export const institutionnelScorer: ScoringFunction = axiomScorer(INSTITUTIONNEL);

/**
 * Scorer for the SOTA axiom.
 * @public
 */
export const sotaScorer: ScoringFunction = axiomScorer(SOTA);

/**
 * Scorer for the Robuste axiom.
 * @public
 */
export const robusteScorer: ScoringFunction = axiomScorer(ROBUSTE);

/**
 * Scorer for the AntiFragile axiom.
 * @public
 */
export const antiFragileScorer: ScoringFunction = axiomScorer(ANTI_FRAGILE);

/**
 * Scorer for the Profitable axiom.
 * @public
 */
export const profitableScorer: ScoringFunction = axiomScorer(PROFITABLE);

// ---------------------------------------------------------------------------
// ScorerRegistry — supports custom scorers via registry pattern
// ---------------------------------------------------------------------------

/** @public */
export interface RegisteredScorer {
  axiomId: AxiomId | string;
  scorer: ScoringFunction;
}

/**
 * ScorerRegistry — holds built-in and custom scorers.
 *
 * Built-in scorers are pre-registered for all 5 axioms.
 * Custom scorers can override or extend the registry.
 * @public
 */
export class ScorerRegistry {
  private readonly scorers = new Map<string, ScoringFunction>();

  constructor() {
    // Register built-in scorers
    for (const axiom of BUILT_IN_AXIOMS) {
      this.scorers.set(axiom.id, axiomScorer(axiom));
    }
  }

  /**
   * Register (or replace) a scorer for the given axiomId.
   */
  register(axiomId: AxiomId | string, scorer: ScoringFunction): void {
    this.scorers.set(axiomId, scorer);
  }

  /**
   * Retrieve a scorer by axiomId. Returns undefined if not registered.
   */
  get(axiomId: AxiomId | string): ScoringFunction | undefined {
    return this.scorers.get(axiomId);
  }

  /**
   * Score a cycle against all registered scorers in parallel.
   */
  async scoreAll(cycle: CycleSnapshot): Promise<Map<string, ScoringResult>> {
    const entries = [...this.scorers.entries()];
    const results = await Promise.all(
      entries.map(async ([id, scorer]) => {
        const result = await scorer(cycle);
        return [id, result] as const;
      }),
    );
    return new Map(results);
  }

  /**
   * List all registered axiom IDs.
   */
  list(): string[] {
    return [...this.scorers.keys()];
  }
}

/**
 * Singleton default registry pre-loaded with all 5 built-in scorers.
 * @public
 */
export const defaultScorerRegistry = new ScorerRegistry();
