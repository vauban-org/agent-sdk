/**
 * PromiseProgressTracker — Goal-proximity signal for agent loops.
 *
 * Implements the Promise/Progress distinction from AgentPRM (arXiv:2511.08325):
 *   - Promise  = long-term proximity to goal (cosine similarity to goal embedding)
 *   - Progress = immediate step-over-step improvement (delta of promise values)
 *
 * The tracker embeds the goal text lazily (on first `observe` call) to keep
 * the constructor synchronous. Plateau detection flags runs that appear stuck
 * near the goal without converging.
 */

import { cosineSimilarity } from "../safety/immune.js";
import type { EmbedFn } from "./semantic-coherence.js";

// Re-export so callers can import EmbedFn from this module directly.
export type { EmbedFn };

/** @public */
export interface PromiseProgressConfig {
  /**
   * Plateau detection: if |delta| < this over `plateauWindow` consecutive steps,
   * the run is flagged as stalled.
   * Default: 0.02
   */
  plateauEpsilon?: number;
  /**
   * Number of steps to consider for plateau detection.
   * Default: 5
   */
  plateauWindow?: number;
}

/** @public */
export interface PromiseProgressSnapshot {
  /** Latest observed similarity to goal (0–1). */
  promise: number;
  /** Step-over-step delta. Positive = moving toward goal. */
  progress: number;
  /**
   * True when the last `plateauWindow` deltas are all in [-epsilon, +epsilon].
   * Requires at least `plateauWindow` observations.
   */
  isPlateau: boolean;
  /** Number of observations recorded so far. */
  observations: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_PLATEAU_EPSILON = 0.02;
const DEFAULT_PLATEAU_WINDOW = 5;

/** @public */
export class PromiseProgressTracker {
  private readonly embedFn: EmbedFn;
  private readonly epsilon: number;
  private readonly windowSize: number;

  private goalText: string;
  /** Resolved lazily on first observe(). */
  private goalEmbedding: number[] | null = null;

  /** All observed promise values (cosine to goal). */
  private promiseHistory: number[] = [];
  /**
   * Sliding deque of the last `windowSize` progress deltas.
   * Oldest at index 0; newest appended at the end.
   */
  private deltaWindow: number[] = [];

  constructor(goal: string, embedFn: EmbedFn, config?: PromiseProgressConfig) {
    this.goalText = goal;
    this.embedFn = embedFn;
    this.epsilon = config?.plateauEpsilon ?? DEFAULT_PLATEAU_EPSILON;
    this.windowSize = config?.plateauWindow ?? DEFAULT_PLATEAU_WINDOW;
  }

  /**
   * Embed `output`, compute cosine similarity to the goal, update internal
   * state, and return a snapshot.
   *
   * First call triggers lazy embedding of the goal text.
   */
  async observe(output: string): Promise<PromiseProgressSnapshot> {
    // Lazy-initialise goal embedding.
    if (this.goalEmbedding === null) {
      this.goalEmbedding = await this.embedFn(this.goalText);
    }

    const outputEmbedding = await this.embedFn(output);
    const currentPromise = cosineSimilarity(this.goalEmbedding, outputEmbedding);

    // Compute step delta against the previous observation (0 on first step).
    const previousPromise =
      this.promiseHistory.length > 0
        ? this.promiseHistory[this.promiseHistory.length - 1]
        : currentPromise;
    const delta = currentPromise - previousPromise;

    this.promiseHistory.push(currentPromise);

    // Maintain a fixed-size deque for plateau detection.
    this.deltaWindow.push(delta);
    if (this.deltaWindow.length > this.windowSize) {
      this.deltaWindow.shift();
    }

    return this._buildSnapshot(currentPromise, delta);
  }

  /** Return the latest snapshot without recording a new observation. */
  snapshot(): PromiseProgressSnapshot {
    const lastPromise =
      this.promiseHistory.length > 0 ? this.promiseHistory[this.promiseHistory.length - 1] : 0;
    const lastDelta =
      this.deltaWindow.length > 0 ? this.deltaWindow[this.deltaWindow.length - 1] : 0;
    return this._buildSnapshot(lastPromise, lastDelta);
  }

  /**
   * Re-baseline the tracker with a new goal (e.g. after a re-plan).
   * If `newGoal` is omitted the existing goal text is re-embedded (rare, but
   * useful after the embedding model changes).
   */
  async reset(newGoal?: string): Promise<void> {
    if (newGoal !== undefined) {
      this.goalText = newGoal;
    }
    // Force re-embedding on next observe().
    this.goalEmbedding = null;
    this.promiseHistory = [];
    this.deltaWindow = [];
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _buildSnapshot(currentPromise: number, delta: number): PromiseProgressSnapshot {
    return {
      promise: currentPromise,
      progress: delta,
      isPlateau: this._detectPlateau(),
      observations: this.promiseHistory.length,
    };
  }

  /**
   * Plateau = last `windowSize` deltas all satisfy |delta| < epsilon.
   * Requires a full window before declaring stall.
   */
  private _detectPlateau(): boolean {
    if (this.deltaWindow.length < this.windowSize) return false;
    return this.deltaWindow.every((d) => Math.abs(d) < this.epsilon);
  }
}
