/**
 * proactive/types ; the Proactive Cognition Engine domain contract
 * (spec docs/superpowers/specs/2026-07-11-proactive-cognition-engine-design.md).
 * Pure types, zero infra ; the SDK core invariant.
 * @public @experimental
 */

/**
 * One thing the engine noticed, from one of the four trigger sources.
 * @public @experimental
 */
export interface ProactiveCandidate {
  readonly source: "turn" | "schedule" | "event" | "sensor";
  /** The topic/agent/subject this candidate is about (recall key). */
  readonly subject: string;
  /** Structural, PII-free payload (never raw secrets). */
  readonly payload: Record<string, unknown>;
  /** ISO 8601 observation time. */
  readonly observedAt: string;
  /** Associative-recall strength in [0,1], set by the cognition step. */
  readonly recallStrength?: number;
}

/**
 * Where a classified candidate goes. `push` is the only path that interrupts.
 * @public @experimental
 */
export type AttentionClass = "push" | "digest" | "silent";

/** @public @experimental */
export interface AttentionVerdict {
  readonly class: AttentionClass;
  /** Human-readable reason (Art. 14), hashed into the audit step. */
  readonly reason: string;
  /** The critical-floor rule id when class is push by rule; absent otherwise. */
  readonly ruleId?: string;
}

/**
 * A deterministic critical-floor rule: a match forces `push`.
 * @public @experimental
 */
export interface CriticalRule {
  readonly id: string;
  readonly when: (c: ProactiveCandidate) => boolean;
}
