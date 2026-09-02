/**
 * quality/index.ts — Outcome quality scoring (ADR-ECO-039).
 *
 * Promoted from forge consumer in SDK 1.8.0 — see Brief 2026-05-17.
 *
 * Companion to {@link OutcomeRecord.quality}. Each agent's
 * `outcomeMapping(feedback)` returns a normalized quality score (0..1)
 * computed from feedback signals. The Command Center backend reads this
 * into the `agent_run.outcome_quality` column (NUMERIC(5,4)), which
 * powers the EconomicObserver ROI weighting and the Quality Foreman
 * regression checks.
 *
 * Design notes:
 *  - Pure function (no I/O, no SDK imports beyond types) — safe to import
 *    from any agent and cheap to unit-test.
 *  - Signals are agent-agnostic — each agent maps its own feedback fields
 *    into a shared {@link QualityInputs} shape.
 *  - Default score is `0.5` ("neutral, no information"). Signals nudge it
 *    up (positive outcomes) or down (errors). Final value is clamped to
 *    `[0, 1]`.
 *  - `customScore` lets an agent provide its own pre-computed score (e.g.
 *    a model-based eval) and bypass the heuristic.
 *  - Prod-validated on 33 forge agents (ADR-ECO-039 rollout 2026-05).
 *
 * @public
 */

/**
 * Feedback signals consumed by {@link computeQuality}. All fields are
 * optional — pass only the signals the calling agent emits.
 *
 * @public
 */
export interface QualityInputs {
  /** Sentinel-style: number of threats blocked (e.g. paused contracts). */
  readonly threatsBlocked?: number;
  /** Sentinel/ops-style: alerts sent to operators. */
  readonly alertsSent?: number;
  /** Content-style: number of posts/articles successfully published. */
  readonly postsPublished?: number;
  /** Content-style: posts blocked by HITL or constitutional gate. */
  readonly postsRejectedByHITL?: number;
  /** Finance/treasury-style: invoices or proposals processed successfully. */
  readonly invoicesProcessed?: number;
  /** Generic: number of errors encountered during the cycle. */
  readonly errorsEncountered?: number;
  /** Lessons / retrospective bullets extracted (proxy for reflection depth). */
  readonly lessons?: readonly unknown[];
  /** Explicit override — bypasses the heuristic when defined. */
  readonly customScore?: number;
}

/**
 * Per-signal contribution to the final score. Returned by
 * {@link computeQualityWithBreakdown}.
 *
 * @public
 */
export interface QualityContribution {
  /** Source signal name (matches a {@link QualityInputs} field). */
  readonly signal: string;
  /** Signed delta applied to the running score (positive or negative). */
  readonly delta: number;
  /** Human-readable explanation, e.g. `"1 post published"`. */
  readonly reason: string;
}

/**
 * Breakdown view of {@link computeQuality} — score plus the ordered list of
 * non-zero contributions. Powers debug-grade observability surfaces
 * (e.g. `/agents/[id]` quality trend tooltip).
 *
 * @public
 */
export interface QualityBreakdown {
  /** Final clamped score in `[0, 1]`. */
  readonly score: number;
  /** Contributions in evaluation order. Empty when no signal applies. */
  readonly contributions: readonly QualityContribution[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Productive-cycle extension of {@link QualityInputs} for event-driven
 * agents whose cycles are mostly idle.
 *
 * SDK 2.25 ; Productive Cycle Evidence pattern (ADR-052 candidate).
 *
 * When `workUnits` is explicit, it overrides the per-signal sum. Otherwise
 * the agent is "productive" iff any work-emitting signal is > 0
 * (postsPublished, threatsBlocked, alertsSent, invoicesProcessed) or
 * errorsEncountered > 0 (the agent tried, the failure carries signal).
 *
 * @public
 */
export interface ProductiveQualityInputs extends QualityInputs {
  /**
   * Total work units the agent attempted this cycle. When defined,
   * `workUnits === 0` marks the cycle as idle ; when undefined, idleness
   * is inferred from the per-signal counts.
   */
  readonly workUnits?: number;
}

/**
 * Returns true when the cycle did no work and has no error to report.
 *
 * `customScore` defined ⇒ explicit eval, never idle.
 * `workUnits` defined ⇒ trust it (0 = idle, any positive = productive).
 * Otherwise infer from per-signal counts.
 *
 * @public
 */
export function isIdleCycle(inputs: ProductiveQualityInputs): boolean {
  if (typeof inputs.customScore === "number") return false;
  if (typeof inputs.workUnits === "number") return inputs.workUnits === 0;
  if ((inputs.postsPublished ?? 0) > 0) return false;
  if ((inputs.threatsBlocked ?? 0) > 0) return false;
  if ((inputs.alertsSent ?? 0) > 0) return false;
  if ((inputs.invoicesProcessed ?? 0) > 0) return false;
  if ((inputs.postsRejectedByHITL ?? 0) > 0) return false;
  if ((inputs.errorsEncountered ?? 0) > 0) return false;
  // Lessons alone are reflection signal, not work ; an agent extracting
  // a lesson from nothing-happened is still idle. Same for empty inputs.
  return true;
}

/**
 * Productive-cycle variant of {@link computeQuality}. Returns `null` when
 * the cycle is idle (no work attempted, no error) ; otherwise returns the
 * same 0..1 score as {@link computeQuality}.
 *
 * Use this for event-driven agents whose cycles are mostly idle (e.g.
 * release broadcaster waiting for a webhook, verify-task-runner waiting
 * for a build-task). Idle cycles SHOULD record their happening (cycle
 * count, latency, success) but MUST NOT pollute the quality moving
 * average used for L1→L2 promotion gating.
 *
 * SDK 2.25 ; Productive Cycle Evidence pattern (ADR-052 candidate).
 *
 * @example
 *   computeQualityOrNull({ workUnits: 0 })                // → null (idle)
 *   computeQualityOrNull({ postsPublished: 1 })           // → 0.7 (productive)
 *   computeQualityOrNull({ errorsEncountered: 1 })        // → 0.3 (failed productive)
 *   computeQualityOrNull({ customScore: 0.95 })           // → 0.95 (explicit eval)
 *
 * @public
 */
export function computeQualityOrNull(inputs: ProductiveQualityInputs): number | null {
  if (isIdleCycle(inputs)) return null;
  return computeQuality(inputs);
}

/**
 * Compute a 0..1 quality score from agent feedback signals.
 *
 * Defaults to `0.5` when no signal is provided. Each positive signal nudges
 * the score upward; errors and HITL rejections nudge it downward. The
 * result is clamped to `[0, 1]`.
 *
 * @example
 *   computeQuality({ postsPublished: 1 })          // → 0.7
 *   computeQuality({ errorsEncountered: 1 })       // → 0.3
 *   computeQuality({ customScore: 0.95 })          // → 0.95
 *   computeQuality({})                             // → 0.5
 *
 * @public
 */
export function computeQuality(inputs: QualityInputs): number {
  if (typeof inputs.customScore === "number") {
    return clamp01(inputs.customScore);
  }

  let q = 0.5;

  if ((inputs.errorsEncountered ?? 0) > 0) q -= 0.2;
  if ((inputs.postsRejectedByHITL ?? 0) > 0) q -= 0.1;

  if ((inputs.postsPublished ?? 0) > 0) q += 0.2;
  if ((inputs.threatsBlocked ?? 0) > 0) q += 0.3;
  if ((inputs.alertsSent ?? 0) > 0) q += 0.1;
  if ((inputs.invoicesProcessed ?? 0) > 0) q += 0.2;
  if ((inputs.lessons?.length ?? 0) > 0) q += 0.05;

  return clamp01(q);
}

/**
 * Same heuristic as {@link computeQuality}, but also returns the ordered
 * list of non-zero contributions for debug-grade observability.
 *
 * When `customScore` is provided, the breakdown contains a single entry
 * tagged `"customScore"` and the heuristic is bypassed.
 *
 * @example
 *   computeQualityWithBreakdown({ postsPublished: 1, lessons: ["a"] })
 *   // → {
 *   //     score: 0.75,
 *   //     contributions: [
 *   //       { signal: "postsPublished", delta:  0.2,  reason: "1 post published" },
 *   //       { signal: "lessons",        delta:  0.05, reason: "1 lesson extracted" },
 *   //     ],
 *   //   }
 *
 * @public
 */
export function computeQualityWithBreakdown(inputs: QualityInputs): QualityBreakdown {
  if (typeof inputs.customScore === "number") {
    const clamped = clamp01(inputs.customScore);
    return {
      score: clamped,
      contributions: [
        {
          signal: "customScore",
          delta: clamped - 0.5,
          reason: `customScore override = ${inputs.customScore}`,
        },
      ],
    };
  }

  let q = 0.5;
  const contributions: QualityContribution[] = [];

  const errors = inputs.errorsEncountered ?? 0;
  if (errors > 0) {
    q -= 0.2;
    contributions.push({
      signal: "errorsEncountered",
      delta: -0.2,
      reason: `${errors} error${errors === 1 ? "" : "s"} encountered`,
    });
  }

  const rejects = inputs.postsRejectedByHITL ?? 0;
  if (rejects > 0) {
    q -= 0.1;
    contributions.push({
      signal: "postsRejectedByHITL",
      delta: -0.1,
      reason: `${rejects} post${rejects === 1 ? "" : "s"} rejected by HITL`,
    });
  }

  const posts = inputs.postsPublished ?? 0;
  if (posts > 0) {
    q += 0.2;
    contributions.push({
      signal: "postsPublished",
      delta: 0.2,
      reason: `${posts} post${posts === 1 ? "" : "s"} published`,
    });
  }

  const threats = inputs.threatsBlocked ?? 0;
  if (threats > 0) {
    q += 0.3;
    contributions.push({
      signal: "threatsBlocked",
      delta: 0.3,
      reason: `${threats} threat${threats === 1 ? "" : "s"} blocked`,
    });
  }

  const alerts = inputs.alertsSent ?? 0;
  if (alerts > 0) {
    q += 0.1;
    contributions.push({
      signal: "alertsSent",
      delta: 0.1,
      reason: `${alerts} alert${alerts === 1 ? "" : "s"} sent`,
    });
  }

  const invoices = inputs.invoicesProcessed ?? 0;
  if (invoices > 0) {
    q += 0.2;
    contributions.push({
      signal: "invoicesProcessed",
      delta: 0.2,
      reason: `${invoices} invoice${invoices === 1 ? "" : "s"} processed`,
    });
  }

  const lessonCount = inputs.lessons?.length ?? 0;
  if (lessonCount > 0) {
    q += 0.05;
    contributions.push({
      signal: "lessons",
      delta: 0.05,
      reason: `${lessonCount} lesson${lessonCount === 1 ? "" : "s"} extracted`,
    });
  }

  return { score: clamp01(q), contributions };
}
