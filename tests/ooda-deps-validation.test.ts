/**
 * OODA boot validation — OODAAgentDeps strict mode (plan v6 §3.7).
 *
 * Sprint: sprint-615:quick-3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LLMProviderPort,
  MissingDependencyError,
  type OODAAgentConfig,
  type PhaseDef,
  createOODAAgent,
  noopLogger,
} from "../src/index.js";
import type { DbClient } from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fakeDb: DbClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

const mockLLM: LLMProviderPort = {
  complete: async () => ({
    content: "ok",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "mock",
    finishReason: "stop",
  }),
};

function ro<TIn, TOut>(p: PhaseDef<TIn, TOut>): PhaseDef<TIn, TOut> {
  return { ...p, readOnly: true };
}

function baseConfig(
  override: Partial<OODAAgentConfig> = {},
): OODAAgentConfig<unknown, number, number, number, number, number> {
  return {
    agentId: "test-agent",
    intervalMs: 0,
    executionMode: "dry-run",
    db: fakeDb,
    logger: noopLogger,
    phases: {
      observe: ro({
        type: "observation",
        fn: async () => 1,
      }) as PhaseDef<void, number>,
      orient: ro({
        type: "retrieval",
        fn: async (i: number) => i + 1,
      }) as PhaseDef<number, number>,
      decide: {
        type: "decision",
        fn: async (i: number) => i + 1,
      },
      act: {
        type: "execution",
        fn: async (i: number) => i + 1,
      },
      feedback: {
        type: "feedback",
        fn: async (i: number) => i + 1,
      },
    },
    ...override,
  } as OODAAgentConfig<unknown, number, number, number, number, number>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OODA boot validation — deps strict mode", () => {
  const originalEnv = process.env.SDK_STRICT_DEPS;

  beforeEach(() => {
    // 0.17: strict mode requires explicit opt-in (1.0 will flip the default)
    process.env.SDK_STRICT_DEPS = "true";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SDK_STRICT_DEPS;
    } else {
      process.env.SDK_STRICT_DEPS = originalEnv;
    }
  });

  it("throws MissingDependencyError when deps is absent in strict mode (default)", () => {
    // SDK_STRICT_DEPS=true → strict mode active (0.17 opt-in, 1.0 default)
    expect(() => createOODAAgent(baseConfig({ deps: undefined }))).toThrow(MissingDependencyError);

    expect(() => createOODAAgent(baseConfig({ deps: undefined }))).toThrow(/deps\.llm/);
  });

  it("throws MissingDependencyError when deps.llm is missing in strict mode", () => {
    expect(() =>
      createOODAAgent(
        baseConfig({
          deps: {
            // llm intentionally omitted — cast to satisfy TS for the test
            llm: undefined as unknown as LLMProviderPort,
          },
        }),
      ),
    ).toThrow(MissingDependencyError);
  });

  it("succeeds when deps.llm is provided in strict mode", () => {
    expect(() => createOODAAgent(baseConfig({ deps: { llm: mockLLM } }))).not.toThrow();
  });

  it("phases can access context.deps.llm after creation", async () => {
    let capturedLlm: LLMProviderPort | undefined;

    const agent = createOODAAgent(
      baseConfig({
        deps: { llm: mockLLM },
        phases: {
          observe: ro({
            type: "observation",
            fn: async (_input, ctx) => {
              capturedLlm = ctx.deps.llm;
              return 1;
            },
          }) as PhaseDef<void, number>,
          orient: ro({
            type: "retrieval",
            fn: async (i: number) => i + 1,
          }) as PhaseDef<number, number>,
          decide: {
            type: "decision",
            fn: async (i: number) => i + 1,
          },
          act: {
            type: "execution",
            fn: async (i: number) => i + 1,
          },
          feedback: {
            type: "feedback",
            fn: async (i: number) => i + 1,
          },
        },
      }),
    );

    await agent.triggerCycle({ dryRun: true });
    expect(capturedLlm).toBe(mockLLM);
  });

  it("logs warning (no throw) when deps absent and SDK_STRICT_DEPS=false (legacy mode)", () => {
    process.env.SDK_STRICT_DEPS = "false";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => createOODAAgent(baseConfig({ deps: undefined }))).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("legacy mode"));

    warnSpy.mockRestore();
  });
});
