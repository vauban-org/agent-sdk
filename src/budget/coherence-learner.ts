/**
 * coherence-learner — online EMA learning for coherence detector thresholds.
 *
 * Signal: if the user resumes after an `incoherent` stop, that stop was a
 * false positive. The model relaxes thresholds toward upper bounds.
 * After sustained clean completions (low FPR), thresholds can tighten back.
 *
 * This is a pure module (no file I/O, no side effects). Persistence is the
 * caller's responsibility (CLI writes to ~/.preste/coherence-model.json).
 * @public
 */

export interface CoherenceModel {
  /** Current learned loop-detection window. Default: 6. Range: [6, 16]. */
  loopDetectionWindow: number;
  /** Current learned stall threshold. Default: 10. Range: [10, 30]. */
  stallThreshold: number;
  /** Total episodes observed. */
  episodes: number;
  /** Running false-positive rate (0–1). */
  falsePositiveRate: number;
  /** Unix ms of last update. */
  lastUpdated: number;
}

/** @public */
export interface CoherenceEpisode {
  stopReason: string;
  stepCount: number;
  /** True when the user resumed after an `incoherent` stop — clear FP signal. */
  isFalsePositive: boolean;
}

// EMA learning rate. 0.3 = 3 FP episodes to reach ~65% of the upper bound.
const α = 0.3;

// Bounds
const WINDOW_MIN = 6;
const WINDOW_MAX = 16;
const STALL_MIN = 10;
const STALL_MAX = 30;

/** @public */
export function defaultCoherenceModel(): CoherenceModel {
  return {
    loopDetectionWindow: WINDOW_MIN,
    stallThreshold: STALL_MIN,
    episodes: 0,
    falsePositiveRate: 0,
    lastUpdated: Date.now(),
  };
}

/**
 * Return an updated model given one new episode observation.
 * Does NOT mutate the input — returns a new object.
 * @public
 */
export function updateCoherenceModel(
  model: CoherenceModel,
  episode: CoherenceEpisode,
): CoherenceModel {
  const n = model.episodes + 1;
  const fpr = (model.falsePositiveRate * model.episodes + (episode.isFalsePositive ? 1 : 0)) / n;

  let window = model.loopDetectionWindow;
  let stall = model.stallThreshold;

  if (episode.isFalsePositive) {
    // Relax toward upper bounds — agent legitimately needed more steps.
    window = Math.min(WINDOW_MAX, Math.round(window + α * (WINDOW_MAX - window)));
    stall = Math.min(STALL_MAX, Math.round(stall + α * (STALL_MAX - stall)));
  } else if (episode.stopReason === "complete" && fpr < 0.05 && n >= 10) {
    // Sustained good performance: slowly tighten back toward defaults.
    window = Math.max(WINDOW_MIN, Math.round(window - α * (window - WINDOW_MIN) * 0.3));
    stall = Math.max(STALL_MIN, Math.round(stall - α * (stall - STALL_MIN) * 0.3));
  }

  return {
    loopDetectionWindow: window,
    stallThreshold: stall,
    episodes: n,
    falsePositiveRate: fpr,
    lastUpdated: Date.now(),
  };
}

/**
 * Validate and repair a model loaded from disk (e.g. after a preste upgrade
 * that changed bounds). Clamps all numeric fields to valid ranges.
 * @public
 */
export function repairCoherenceModel(raw: unknown): CoherenceModel {
  const defaults = defaultCoherenceModel();
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Record<string, unknown>;
  return {
    loopDetectionWindow: clamp(
      typeof r.loopDetectionWindow === "number"
        ? r.loopDetectionWindow
        : defaults.loopDetectionWindow,
      WINDOW_MIN,
      WINDOW_MAX,
    ),
    stallThreshold: clamp(
      typeof r.stallThreshold === "number" ? r.stallThreshold : defaults.stallThreshold,
      STALL_MIN,
      STALL_MAX,
    ),
    episodes: typeof r.episodes === "number" ? Math.max(0, Math.floor(r.episodes)) : 0,
    falsePositiveRate: clamp(
      typeof r.falsePositiveRate === "number" ? r.falsePositiveRate : 0,
      0,
      1,
    ),
    lastUpdated: typeof r.lastUpdated === "number" ? r.lastUpdated : Date.now(),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
