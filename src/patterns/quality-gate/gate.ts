/**
 * Pattern B: Quality Gate — factory implementation.
 * @public
 */
import { logToBrain } from "../_shared/brain-logger.js";
import type { QualityGate, QualityGateConfig, QualityRouting, QualityScore } from "./types.js";

const NOOP = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createQualityGate<T>(config: QualityGateConfig<T>): QualityGate<T> {
  if (config.evaluators.length === 0) {
    throw new Error(`[quality-gate:${config.name}] evaluators must not be empty`);
  }
  const autoProceed = config.autoProceedThreshold ?? 0.8;
  const asyncReview = config.asyncReviewThreshold ?? 0.5;
  if (asyncReview >= autoProceed) {
    throw new Error(
      `[quality-gate:${config.name}] asyncReviewThreshold(${asyncReview}) must be < autoProceedThreshold(${autoProceed})`,
    );
  }
  const logger = config.logger ?? NOOP;

  return {
    async evaluate(subject: T): Promise<QualityScore> {
      const dims: Array<{ name: string; score: number; weight: number }> = [];
      let totalWeight = 0;
      let weightedSum = 0;

      for (const ev of config.evaluators) {
        const w = ev.weight ?? 1;
        let s = 0;
        try {
          const raw = await ev.evaluate(subject);
          // NaN/Infinity guard — misbehaving evaluators score 0 without propagating
          s = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
        } catch (err) {
          logger.error(
            { evaluator: ev.name, err },
            `[quality-gate:${config.name}] evaluator '${ev.name}' threw — scoring 0`,
          );
        }
        dims.push({ name: ev.name, score: s, weight: w });
        totalWeight += w;
        weightedSum += s * w;
      }

      const overall = totalWeight > 0 ? weightedSum / totalWeight : 0;
      const routing: QualityRouting =
        overall >= autoProceed ? "auto" : overall >= asyncReview ? "async_review" : "hitl_block";

      const score: QualityScore = { overall, routing, dimensions: dims };

      logger.info(
        { gate: config.name, overall, routing },
        `[quality-gate:${config.name}] ${overall.toFixed(3)} → ${routing}`,
      );

      // category: "operations" — these are production quality metrics, not debug logs
      logToBrain(config.brain, {
        content: `Quality gate '${config.name}': overall=${overall.toFixed(3)} routing=${routing}. ${dims.map((d) => `${d.name}=${d.score.toFixed(3)}`).join(", ")}`,
        content_type: "metric",
        author: `quality-gate:${config.name}`,
        category: "operations",
        tags: ["quality-gate", config.name, routing],
        confidence: overall,
        metadata: { score: score as unknown as Record<string, unknown> },
      });

      if (routing === "hitl_block") {
        logger.warn(
          { gate: config.name, overall },
          `[quality-gate:${config.name}] hitl_block triggered`,
        );
        try {
          config.onHitlBlock?.(score, subject);
        } catch {
          /* suppress */
        }
      }

      return score;
    },
  };
}
