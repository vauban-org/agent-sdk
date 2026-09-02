/**
 * tests/phase-routing.test.ts
 *
 * Sprint-563: B4 — Phase-level model routing + ModelSpec.fallback cascade.
 */

import { describe, expect, it } from "vitest";
import { getFallbackChain, resolveForPhase } from "../src/orchestration/ooda/phase-routing.js";
import type { ModelSpec, PhaseModelConfig } from "../src/orchestration/ooda/phase-routing.js";

const anthropic: ModelSpec = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

const groq: ModelSpec = {
  provider: "groq",
  model: "llama-3.3-70b",
};

const litellm: ModelSpec = {
  provider: "litellm",
  model: "qwen3-8b",
};

const config: PhaseModelConfig = {
  defaultModel: groq,
  phases: {
    orient: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      costTracking: true,
      temperature: 0.7,
      fallback: [groq, litellm],
    },
    decide: anthropic,
  },
};

describe("resolveForPhase", () => {
  it("returns phase-specific model when configured", () => {
    const spec = resolveForPhase(config, "orient");
    expect(spec.provider).toBe("anthropic");
    expect(spec.model).toBe("claude-sonnet-4-6");
    expect(spec.temperature).toBe(0.7);
  });

  it("returns default model for unconfigured phases", () => {
    expect(resolveForPhase(config, "execution").provider).toBe("groq");
    expect(resolveForPhase(config, "feedback").provider).toBe("groq");
  });
});

describe("getFallbackChain", () => {
  it("includes primary model first, then its fallbacks, then default", () => {
    const chain = getFallbackChain(config, "orient");

    expect(chain).toHaveLength(3); // deduplicated: groq in fallback[0] === defaultModel
    expect(chain[0]!.provider).toBe("anthropic");
    expect(chain[1]!.provider).toBe("groq");
    expect(chain[2]!.provider).toBe("litellm");
  });

  it("deduplicates identical provider:model pairs", () => {
    // orient fallback[0] === groq, same as defaultModel
    const chain = getFallbackChain(config, "orient");
    const keys = chain.map((s) => `${s.provider}:${s.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns just default for unconfigured phase", () => {
    const chain = getFallbackChain(config, "observation");
    expect(chain).toHaveLength(1);
    expect(chain[0]!.provider).toBe("groq");
  });
});
