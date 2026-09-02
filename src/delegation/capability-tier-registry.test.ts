/**
 * capability-tier-registry.test.ts — unit matrix for the C1 capability
 * tier/HITL registry (packages/cli/docs/teammates-l2-plan.md Sprint L2-C).
 *
 * Covers: lookup of a classified capability (direct + mcp__-prefixed alias),
 * default for an unknown capability, config-sourced overrides winning over
 * the default, and a custom default overriding the built-in permissive one.
 */

import { describe, expect, it } from "vitest";
import {
  type CapabilityTierOverrides,
  DEFAULT_CAPABILITY_TIER_CLASSIFICATION,
  createCapabilityTierRegistry,
} from "./capability-tier-registry.js";

describe("createCapabilityTierRegistry", () => {
  it("classifies a capability present in the overrides map", () => {
    const registry = createCapabilityTierRegistry({
      overrides: { sign_transaction: { tier: "T4", hitl: true } },
    });

    expect(registry.classify("sign_transaction")).toEqual({ tier: "T4", hitl: true });
  });

  it("normalizes an mcp__<server>__ prefixed capability to the SAME baseToolName entry", () => {
    const registry = createCapabilityTierRegistry({
      overrides: { invoke_on_sepolia: { tier: "T3", hitl: true } },
    });

    expect(registry.classify("mcp__starknet__invoke_on_sepolia")).toEqual({
      tier: "T3",
      hitl: true,
    });
  });

  it("returns the permissive default (T1, no HITL) for an unclassified capability", () => {
    const registry = createCapabilityTierRegistry({
      overrides: { sign_transaction: { tier: "T4", hitl: true } },
    });

    expect(registry.classify("get_daily_digest")).toEqual(DEFAULT_CAPABILITY_TIER_CLASSIFICATION);
  });

  it("returns the permissive default for every capability when no overrides are supplied", () => {
    const registry = createCapabilityTierRegistry();

    expect(registry.classify("anything")).toEqual(DEFAULT_CAPABILITY_TIER_CLASSIFICATION);
  });

  it("config-sourced overrides win over the default (the same map, config- or code-supplied)", () => {
    // Shape-compatible with PresteConfig.capability_tiers as loaded from
    // config.yaml — this module has no config-file dependency, but the
    // overrides map is structurally the same data either way.
    const configSourcedOverrides: CapabilityTierOverrides = {
      update_task_status: { tier: "T2", hitl: false },
      make_payment: { tier: "T4", hitl: true },
    };
    const registry = createCapabilityTierRegistry({ overrides: configSourcedOverrides });

    expect(registry.classify("update_task_status")).toEqual({ tier: "T2", hitl: false });
    expect(registry.classify("make_payment")).toEqual({ tier: "T4", hitl: true });
    // an unrelated capability still falls through to the default, proving
    // the override only shadows the entries it declares.
    expect(registry.classify("read_file")).toEqual(DEFAULT_CAPABILITY_TIER_CLASSIFICATION);
  });

  it("honors a custom defaultClassification when supplied", () => {
    const registry = createCapabilityTierRegistry({
      defaultClassification: { tier: "T2", hitl: true },
    });

    expect(registry.classify("unclassified_capability")).toEqual({ tier: "T2", hitl: true });
  });
});
