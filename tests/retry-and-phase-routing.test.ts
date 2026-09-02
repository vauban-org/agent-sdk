/**
 * Tests for:
 *   src/retry/presets.ts — retry preset configs + retryIf logic
 *   src/orchestration/ooda/phase-routing.ts — resolveForPhase, getFallbackChain
 *
 * Coverage:
 *   RETRY_TRANSIENT.retryIf — retryable:true → true, retryable:false → false,
 *     no flag → defaults to true (transient)
 *   NO_RETRY — maxAttempts=1, jitter=false
 *   RETRY_AGGRESSIVE — maxAttempts=5
 *   RETRY_PATIENT — maxAttempts=10
 *   resolveForPhase — returns phase-specific model when configured,
 *     returns defaultModel when phase has no config
 *   getFallbackChain — includes primary + fallback + default,
 *     deduplicates provider:model pairs,
 *     when no phase config, only default (+ fallback) in chain
 *
 * Ref: test coverage for retry presets + phase-routing (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { getFallbackChain, resolveForPhase } from "../src/orchestration/ooda/phase-routing.js";
import type { PhaseModelConfig } from "../src/orchestration/ooda/phase-routing.js";
import {
  NO_RETRY,
  RETRY_AGGRESSIVE,
  RETRY_PATIENT,
  RETRY_TRANSIENT,
} from "../src/retry/presets.js";

// ─── Retry presets ────────────────────────────────────────────────────────────

describe("RETRY_TRANSIENT.retryIf", () => {
  it("returns true when error has retryable:true", () => {
    expect(RETRY_TRANSIENT.retryIf!({ retryable: true })).toBe(true);
  });

  it("returns false when error has retryable:false", () => {
    expect(RETRY_TRANSIENT.retryIf!({ retryable: false })).toBe(false);
  });

  it("defaults to true when error has no retryable flag", () => {
    expect(RETRY_TRANSIENT.retryIf!(new Error("network"))).toBe(true);
  });

  it("defaults to true for plain object without retryable", () => {
    expect(RETRY_TRANSIENT.retryIf!({ message: "timeout" })).toBe(true);
  });
});

describe("RETRY_TRANSIENT config", () => {
  it("maxAttempts=3", () => {
    expect(RETRY_TRANSIENT.maxAttempts).toBe(3);
  });

  it("jitter=true", () => {
    expect(RETRY_TRANSIENT.jitter).toBe(true);
  });
});

describe("RETRY_AGGRESSIVE config", () => {
  it("maxAttempts=5", () => {
    expect(RETRY_AGGRESSIVE.maxAttempts).toBe(5);
  });

  it("jitter=true", () => {
    expect(RETRY_AGGRESSIVE.jitter).toBe(true);
  });
});

describe("RETRY_PATIENT config", () => {
  it("maxAttempts=10", () => {
    expect(RETRY_PATIENT.maxAttempts).toBe(10);
  });

  it("maxDelayMs=120_000 (long recovery)", () => {
    expect(RETRY_PATIENT.maxDelayMs).toBe(120_000);
  });
});

describe("NO_RETRY config", () => {
  it("maxAttempts=1", () => {
    expect(NO_RETRY.maxAttempts).toBe(1);
  });

  it("jitter=false", () => {
    expect(NO_RETRY.jitter).toBe(false);
  });

  it("baseDelayMs=0", () => {
    expect(NO_RETRY.baseDelayMs).toBe(0);
  });
});

// ─── phase-routing.ts ────────────────────────────────────────────────────────

const DEFAULT_MODEL = { provider: "groq", model: "llama-3.3-70b" };
const OBSERVE_MODEL = { provider: "litellm", model: "qwen3-8b" };
const DECIDE_MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  fallback: [{ provider: "groq", model: "llama-3.3-70b" }],
};

const CONFIG: PhaseModelConfig = {
  defaultModel: DEFAULT_MODEL,
  phases: {
    observe: OBSERVE_MODEL,
    decide: DECIDE_MODEL,
  },
};

describe("resolveForPhase", () => {
  it("returns phase-specific model when configured", () => {
    expect(resolveForPhase(CONFIG, "observe")).toBe(OBSERVE_MODEL);
    expect(resolveForPhase(CONFIG, "decide")).toBe(DECIDE_MODEL);
  });

  it("returns defaultModel when phase has no explicit config", () => {
    expect(resolveForPhase(CONFIG, "act")).toBe(DEFAULT_MODEL);
    expect(resolveForPhase(CONFIG, "orient")).toBe(DEFAULT_MODEL);
  });
});

describe("getFallbackChain", () => {
  it("includes primary model first for configured phase", () => {
    const chain = getFallbackChain(CONFIG, "decide");
    expect(chain[0]).toBe(DECIDE_MODEL);
  });

  it("includes primary fallback in chain after primary", () => {
    const chain = getFallbackChain(CONFIG, "decide");
    // DECIDE_MODEL.fallback = [groq/llama-3.3-70b]
    expect(chain[1].model).toBe("llama-3.3-70b");
    expect(chain[1].provider).toBe("groq");
  });

  it("deduplicates provider:model pairs", () => {
    // DECIDE_MODEL fallback = groq/llama; defaultModel = groq/llama → deduplicated
    const chain = getFallbackChain(CONFIG, "decide");
    const keys = chain.map((s) => `${s.provider}:${s.model}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it("falls back to defaultModel when phase has no config", () => {
    const chain = getFallbackChain(CONFIG, "act");
    expect(chain[0]).toBe(DEFAULT_MODEL);
  });

  it("returns at least one entry (the default) for any phase", () => {
    expect(getFallbackChain(CONFIG, "act").length).toBeGreaterThanOrEqual(1);
    expect(getFallbackChain(CONFIG, "observe").length).toBeGreaterThanOrEqual(1);
  });
});
