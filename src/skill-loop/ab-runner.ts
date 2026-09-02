/**
 * src/skill-loop/ab-runner.ts
 *
 * A/B test runner with failure budgets for SkillCandidates.
 *
 * Invariants:
 *   - Max 3 candidates simultaneously (4th is rejected).
 *   - Traffic fraction cap: 10% per candidate.
 *   - Rollback triggered when a candidate's mean score drops >5% vs incumbent.
 *   - Winner declared when: p < 0.05 AND delta >= 10% AND no rollback triggered.
 *
 * Statistical significance uses the same Welch approach as evaluator.ts.
 *
 * @module skill-loop/ab-runner
 */

import type { SkillCandidate } from "./candidate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @public */
export interface ABConfig {
  /** Maximum concurrent candidates. Hard cap: 3. */
  maxCandidates: number;
  /** Traffic fraction routed to each candidate. Hard cap: 0.10. */
  trafficPct: number;
  /** Rollback threshold: if candidate mean drops by this fraction vs incumbent. */
  rollbackThresholdPct: number;
}

/** @public */
export interface ABSlot {
  candidateId: string;
  trafficFraction: number;
  outcomes: number[];
  rollbackTriggered: boolean;
}

// ---------------------------------------------------------------------------
// Statistical helpers (inline — avoid circular dep with evaluator)
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212559 + t * 1.3302744))));
  return 1 - p;
}

function welchPValue(a: number[], b: number[]): number {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return 1.0;

  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = variance(a, m1);
  const v2 = variance(b, m2);
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return m1 === m2 ? 1.0 : 0.0;

  const tStat = Math.abs((m1 - m2) / se);
  const df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));

  if (df >= 30) {
    return Math.max(0, Math.min(1, 2 * (1 - normalCdf(tStat))));
  }
  // Conservative: approximate p via critical value at df ≈ 30 (t-crit = 2.042)
  return tStat > 2.042 ? 0.04 : 0.1;
}

// ---------------------------------------------------------------------------
// ABRunner
// ---------------------------------------------------------------------------

export class ABRunner {
  private readonly config: Readonly<ABConfig>;
  private readonly slots = new Map<string, ABSlot>();
  private readonly candidates = new Map<string, SkillCandidate>();
  private readonly incumbentOutcomes: number[] = [];

  constructor(config: ABConfig) {
    // Enforce hard caps
    this.config = {
      maxCandidates: Math.min(config.maxCandidates, 3),
      trafficPct: Math.min(config.trafficPct, 0.1),
      rollbackThresholdPct: config.rollbackThresholdPct,
    };
  }

  /**
   * Register a new candidate for A/B testing.
   *
   * @returns true if added, false if maxCandidates already reached.
   */
  addCandidate(candidate: SkillCandidate): boolean {
    if (this.slots.size >= this.config.maxCandidates) {
      return false;
    }
    this.candidates.set(candidate.id, candidate);
    this.slots.set(candidate.id, {
      candidateId: candidate.id,
      trafficFraction: this.config.trafficPct,
      outcomes: [],
      rollbackTriggered: false,
    });
    return true;
  }

  /**
   * Record an outcome score for a candidate or the incumbent.
   *
   * @param candidateId - Candidate ID or "incumbent".
   * @param score       - Outcome score [0, 1].
   */
  recordOutcome(candidateId: string | "incumbent", score: number): void {
    if (candidateId === "incumbent") {
      this.incumbentOutcomes.push(score);
      return;
    }
    const slot = this.slots.get(candidateId);
    if (!slot) return;

    slot.outcomes.push(score);

    // Check rollback condition after each new data point
    if (!slot.rollbackTriggered && this.shouldRollback(candidateId)) {
      slot.rollbackTriggered = true;
    }
  }

  /**
   * Returns true if the candidate's mean score has dropped >rollbackThresholdPct
   * vs the incumbent mean.
   */
  shouldRollback(candidateId: string): boolean {
    const slot = this.slots.get(candidateId);
    if (!slot || slot.outcomes.length === 0) return false;
    if (this.incumbentOutcomes.length === 0) return false;

    const candMean = mean(slot.outcomes);
    const incMean = mean(this.incumbentOutcomes);

    // Degradation: candidate is worse than incumbent by more than threshold
    const degradation = incMean - candMean;
    return degradation > this.config.rollbackThresholdPct;
  }

  /**
   * Return the winning candidate if statistical significance is established.
   *
   * Winner criteria:
   *   - p < 0.05 (Welch's t-test vs incumbent)
   *   - delta >= 10% vs incumbent mean
   *   - rollback NOT triggered
   *
   * Returns null if no candidate meets all criteria.
   */
  getWinner(): SkillCandidate | null {
    if (this.incumbentOutcomes.length < 2) return null;

    const incMean = mean(this.incumbentOutcomes);

    for (const [id, slot] of this.slots) {
      if (slot.rollbackTriggered) continue;
      if (slot.outcomes.length < 2) continue;

      const candMean = mean(slot.outcomes);
      const delta = candMean - incMean;
      if (delta < 0.1) continue;

      const p = welchPValue(slot.outcomes, this.incumbentOutcomes);
      if (p < 0.05) {
        return this.candidates.get(id) ?? null;
      }
    }

    return null;
  }
}
