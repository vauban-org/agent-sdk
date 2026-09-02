/**
 * Phase-level model routing — per-phase model selection with fallback cascade.
 *
 * Sprint-563: B4 — PhaseModelConfig + ModelSpec.fallback + resolveForPhase.
 *
 * Each OODA phase can specify its own model, independent of other phases.
 * When a provider fails (429/503), the fallback cascade tries the next model.
 * resolveForPhase(phaseModels, phase) returns the resolved ModelSpec.
 */

import type { OODAPhaseKind } from "./types.js";

/** @public */
export interface ModelSpec {
  /** Provider identifier (e.g. "anthropic", "groq", "litellm"). */
  provider: string;
  /** Model name (e.g. "claude-sonnet-4-6", "llama-3.3-70b"). */
  model: string;
  /** Fallback cascade — tried in order on failure. */
  fallback?: ModelSpec[];
  /** Whether to track cost for this spec (default true). */
  costTracking?: boolean;
  /** Temperature override for this model. */
  temperature?: number;
  /** Top-p override for this model. */
  topP?: number;
}

/** @public */
export interface PhaseModelConfig {
  /** Per-phase model mapping. Undefined phases use the default model. */
  phases: Partial<Record<OODAPhaseKind, ModelSpec>>;
  /** Default model for phases without explicit config. */
  defaultModel: ModelSpec;
}

/**
 * Resolve the ModelSpec for a given phase. Falls back to defaultModel if
 * the phase has no explicit config.
 * @public
 */
export function resolveForPhase(config: PhaseModelConfig, phase: OODAPhaseKind): ModelSpec {
  return config.phases[phase] ?? config.defaultModel;
}

/**
 * Get the full fallback chain for a phase — the primary model first,
 * then its fallback cascade, then defaultModel + its cascade.
 * @public
 */
export function getFallbackChain(config: PhaseModelConfig, phase: OODAPhaseKind): ModelSpec[] {
  const primary = config.phases[phase];
  const chain: ModelSpec[] = [];

  if (primary) {
    chain.push(primary);
    if (primary.fallback) chain.push(...primary.fallback);
  }

  // Always append default as last resort
  chain.push(config.defaultModel);
  if (config.defaultModel.fallback) chain.push(...config.defaultModel.fallback);

  // Deduplicate by provider+model
  const seen = new Set<string>();
  return chain.filter((spec) => {
    const key = `${spec.provider}:${spec.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
