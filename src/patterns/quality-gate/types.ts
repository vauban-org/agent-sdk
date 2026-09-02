/**
 * Pattern B: Quality Gate — types.
 *
 * Evaluates OODA output quality using weighted evaluator functions before
 * action dispatch. Routes to auto / async_review / hitl_block.
 *
 * @public
 */
import type { BrainPort } from "../../ports/brain.js";
import type { LoggerPort } from "../../ports/logger.js";

export type QualityRouting = "auto" | "async_review" | "hitl_block";

export interface QualityEvaluator<T> {
  readonly name: string;
  readonly weight?: number;
  evaluate(subject: T): Promise<number>; // must return [0, 1]
}

export interface QualityScore {
  readonly overall: number; // [0, 1] weighted mean
  readonly routing: QualityRouting;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly weight: number;
  }>;
}

export interface QualityGateConfig<T> {
  readonly name: string;
  readonly evaluators: ReadonlyArray<QualityEvaluator<T>>;
  /** Score >= this → auto. Default: 0.8 */
  readonly autoProceedThreshold?: number;
  /** Score >= this (and < auto) → async_review. Default: 0.5 */
  readonly asyncReviewThreshold?: number;
  readonly brain?: BrainPort;
  readonly logger?: LoggerPort;
  /** Called when routing = hitl_block. Must not throw. */
  readonly onHitlBlock?: (score: QualityScore, subject: T) => void;
}

export interface QualityGate<T> {
  evaluate(subject: T): Promise<QualityScore>;
}
