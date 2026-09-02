/**
 * createOODAAgent — public factory with boot-time dependency validation.
 *
 * Plan v6 §3.7: strict deps validation at construction.
 * - `SDK_STRICT_DEPS=false`: legacy mode — warn only, do not throw.
 * - `SDK_STRICT_DEPS` absent or any other value: strict mode — throw `MissingDependencyError`.
 *
 * @public
 */

import { createBrainPortFromEnv } from "../../adapters/brain-http.js";
import { OODAAgentImpl } from "./agent.js";
import { MissingDependencyError } from "./errors.js";
import type { OODAAgent, OODAAgentConfig, OODAAgentDeps } from "./types.js";

/**
 * Auto-wire the V12 memory planes (Working / Episodic / Claims) into a config's
 * `deps.memory` when the host did not inject one explicitly. Backed by the env
 * HTTP brain adapter ({@link createBrainPortFromEnv}: `BRAIN_URL` +
 * `BRAIN_TOKEN` | `BRAIN_API_KEY`). This is what makes EVERY OODA agent write to
 * the Episodic + Claims planes without per-agent wiring (ADR-ECO-114): the OODA
 * loop's `_appendEpisodic` / `_assertOutcomeClaim` writers feature-detect
 * `deps.memory` and previously no-op'd because nothing assembled the adapter.
 *
 * Invariants:
 *   - Explicit `deps.memory` always wins (never overwritten).
 *   - No `BRAIN_URL` → no-op (zero-regression for tests/hosts without Brain).
 *   - `SDK_AUTO_MEMORY=false` → opt-out kill-switch (reversible without redeploy).
 *   - A legacy config with no `deps` object is left untouched.
 * @public
 */
export function applyEnvMemory<C extends { agentId: string; deps?: Partial<OODAAgentDeps> }>(
  config: C,
): C {
  if (process.env.SDK_AUTO_MEMORY === "false") return config;
  if (!config.deps || config.deps.memory) return config;
  const envMemory = createBrainPortFromEnv(config.agentId);
  if (!envMemory) return config;
  return { ...config, deps: { ...config.deps, memory: envMemory } };
}

/** @public */
export function createOODAAgent<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
>(config: OODAAgentConfig<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>): OODAAgent {
  // 0.17: default=legacy (opt-in via SDK_STRICT_DEPS=true). 1.0: default=strict.
  const strict = process.env.SDK_STRICT_DEPS === "true";

  if (!config.deps) {
    if (strict) {
      throw new MissingDependencyError("llm");
    }
    // Legacy mode: warn only — will throw in SDK 1.0
    console.warn("[agent-sdk] OODAAgentConfig.deps missing — legacy mode. Will throw in 1.0.");
  } else if (strict && !config.deps.llm) {
    throw new MissingDependencyError("llm");
  }

  // Auto-wire the V12 memory planes (ADR-ECO-114) so every agent's OODA loop
  // writes Episodic + Claims. No-op when Brain env is absent or memory is
  // explicit; see applyEnvMemory. Placed at the single public construction
  // boundary all 14 agents share, so present + future agents inherit it.
  return new OODAAgentImpl<TConfig, TObs, TOrient, TDecision, TAction, TFeedback>(
    applyEnvMemory(config),
  );
}
