/**
 * delegation/capability-tier-registry.ts
 *
 * C1 of the HITL tier-gate slice (packages/cli/docs/teammates-l2-plan.md
 * Sprint L2-C, adversarial #8): "no capability-tier/HITL registry exists
 * (only bash-preview risk heuristics)". This module is the contracts-first
 * source of truth mapping a capability, the SAME flat tool-name vocabulary
 * `delegate.ts`'s `attenuatedTools` and `teammate-message.ts`'s
 * `claim.capability` use, normalized through the SAME `baseToolName()`, to a
 * {@link CapabilityTierClassification}: an AI-agent tier (T1-T4, per
 * vauban-gouvernance `rules/ai/tiered-gates.md`) plus whether the capability
 * requires human-in-the-loop confirmation.
 *
 * NO CONSUMER YET, by design: the plan is "C1 registry-first, C2 [HITL gate
 * on asks] depends on it". This module classifies; it does not gate.
 * Constructing a registry and never calling `classify()` is zero-behavior-
 * change, and nothing in this repo calls `classify()` yet.
 *
 * DEFAULT = PERMISSIVE: an unclassified capability resolves to
 * {@link DEFAULT_CAPABILITY_TIER_CLASSIFICATION} (T1, no HITL), so that until
 * a consumer exists no existing tool is silently gated by omission from this
 * registry.
 *
 * @module delegation/capability-tier-registry
 * @since ADR-ECO-109
 */

import { baseToolName } from "./delegate.js";

/** AI-agent capability tier per vauban-gouvernance `rules/ai/tiered-gates.md` T1-T4. @public */
export type CapabilityTier = "T1" | "T2" | "T3" | "T4";

/**
 * The classification a capability resolves to: its tier plus whether
 * exercising it requires human-in-the-loop confirmation. `hitl` is tracked
 * independently of `tier` (a capability MAY be HITL-gated by local policy
 * even at a tier `tiered-gates.md` does not itself mandate confirmation
 * for).
 * @public
 */
export interface CapabilityTierClassification {
  readonly tier: CapabilityTier;
  readonly hitl: boolean;
}

/**
 * The permissive default returned for any capability with no matching
 * registry entry: T1, no HITL. No consumer of this registry exists yet; a
 * default that changes behavior would have nothing to be conservative
 * relative to.
 * @public
 */
export const DEFAULT_CAPABILITY_TIER_CLASSIFICATION: CapabilityTierClassification = {
  tier: "T1",
  hitl: false,
};

/**
 * Capability -> classification map, keyed by the SAME flat tool-name
 * vocabulary `baseToolName()` normalizes: an `mcp__<server>__` prefix is
 * stripped before lookup, so `mcp__starknet__invoke_on_sepolia` and
 * `invoke_on_sepolia` resolve to the same entry.
 * @public
 */
export type CapabilityTierOverrides = Readonly<Record<string, CapabilityTierClassification>>;

/** Constructor input for {@link createCapabilityTierRegistry}. @public */
export interface CapabilityTierRegistryOptions {
  /**
   * Capability -> classification overrides. A config-sourced map (e.g. the
   * CLI's `PresteConfig.capability_tiers`, loaded from `config.yaml`) and any
   * programmatically-supplied map are both passed through this SAME option;
   * there is no separate precedence between "config" and "built-in", only
   * overrides vs. the registry default.
   */
  readonly overrides?: CapabilityTierOverrides;
  /** Overrides {@link DEFAULT_CAPABILITY_TIER_CLASSIFICATION} for this registry instance. */
  readonly defaultClassification?: CapabilityTierClassification;
}

/** A capability-tier/HITL registry: the C1 source of truth. @public */
export interface CapabilityTierRegistry {
  /**
   * Classify `capability`. Looks up `baseToolName(capability)` against the
   * configured overrides; falls back to the registry's default (permissive
   * unless overridden) when no entry matches.
   */
  classify(capability: string): CapabilityTierClassification;
}

/**
 * Build a {@link CapabilityTierRegistry} from constructor-injected overrides
 * (programmatic use) and/or config-sourced overrides (see
 * `PresteConfig.capability_tiers` in `packages/cli/src/preste-config.ts`,
 * loaded by the CLI and passed in here as plain data; this module has no
 * config-file dependency of its own).
 * @public
 */
export function createCapabilityTierRegistry(
  options: CapabilityTierRegistryOptions = {},
): CapabilityTierRegistry {
  const defaultClassification =
    options.defaultClassification ?? DEFAULT_CAPABILITY_TIER_CLASSIFICATION;
  const normalized = new Map<string, CapabilityTierClassification>();
  for (const [capability, classification] of Object.entries(options.overrides ?? {})) {
    normalized.set(baseToolName(capability), classification);
  }

  return {
    classify(capability: string): CapabilityTierClassification {
      return normalized.get(baseToolName(capability)) ?? defaultClassification;
    },
  };
}
