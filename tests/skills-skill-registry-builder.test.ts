/**
 * Tests for SkillRegistryBuilder (sprint-616:quick-3).
 *
 * Covers:
 * - buildSkills() assembles base skills
 * - buildSkills() merges domain extras
 * - Zod validation: rejects empty agentId / domain
 * - Duplicate detection: base collision, extra-extra collision
 * - buildSkillRegistry() convenience wrapper
 * - llm-complete replay safety
 */

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Skill } from "../src/orchestration/ooda/skills.js";
import { noopLogger } from "../src/ports/logger.js";
import { BASE_SKILL_NAMES } from "../src/skills/base-skills.js";
import { buildSkillRegistry, buildSkills } from "../src/skills/skill-registry-builder.js";
import { makeCtx } from "./skills-helpers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const deps = {
  logger: noopLogger,
};

function makeExtraSkill(name: string): Skill {
  return {
    name,
    inputSchema: { parse: (raw: unknown) => raw as { input: string } },
    async execute() {
      return { done: true };
    },
  };
}

// ─── buildSkills — base ───────────────────────────────────────────────────────

describe("buildSkills — base registry", () => {
  it("includes all BASE_SKILL_NAMES in the registry", () => {
    const { registry, baseNames } = buildSkills({
      agentId: "test-agent",
      deps,
      domain: "test",
    });

    for (const name of BASE_SKILL_NAMES) {
      expect(registry[name], `missing base skill: ${name}`).toBeDefined();
    }
    expect(baseNames).toEqual([...BASE_SKILL_NAMES]);
  });

  it("extraNames is empty when no extras provided", () => {
    const { extraNames } = buildSkills({
      agentId: "test-agent",
      deps,
      domain: "test",
    });
    expect(extraNames).toEqual([]);
  });

  it("returns a plain SkillRegistry (Record<string, Skill>)", () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    expect(typeof registry).toBe("object");
    expect(registry).not.toBeNull();
  });
});

// ─── buildSkills — extras ─────────────────────────────────────────────────────

describe("buildSkills — domain extras", () => {
  it("merges a single extra skill", () => {
    const extra = makeExtraSkill("http-fetch");
    const { registry, extraNames } = buildSkills({
      agentId: "forge-revenue",
      deps,
      domain: "revenue",
      extras: [{ name: "http-fetch", skill: extra }],
    });
    expect(registry["http-fetch"]).toBe(extra);
    expect(extraNames).toEqual(["http-fetch"]);
  });

  it("merges multiple extras from different domains", () => {
    const prometheus = makeExtraSkill("prometheus-query");
    const telegram = makeExtraSkill("telegram-notify");
    const { registry, extraNames } = buildSkills({
      agentId: "forge-ops",
      deps,
      domain: "ops",
      extras: [
        { name: "prometheus-query", skill: prometheus },
        { name: "telegram-notify", skill: telegram },
      ],
    });
    expect(registry["prometheus-query"]).toBe(prometheus);
    expect(registry["telegram-notify"]).toBe(telegram);
    expect(extraNames).toHaveLength(2);
  });

  it("base skills are not overwritten by extras with non-colliding names", () => {
    const { registry } = buildSkills({
      agentId: "test-agent",
      deps,
      domain: "test",
      extras: [{ name: "my-custom-skill", skill: makeExtraSkill("my-custom-skill") }],
    });
    // Base skills still present
    expect(registry["brain-query"]).toBeDefined();
    expect(registry["brain-store"]).toBeDefined();
  });
});

// ─── Zod validation ───────────────────────────────────────────────────────────

describe("buildSkills — Zod validation", () => {
  it("throws ZodError for empty agentId", () => {
    expect(() => buildSkills({ agentId: "", deps, domain: "test" })).toThrow(ZodError);
  });

  it("throws ZodError for empty domain", () => {
    expect(() => buildSkills({ agentId: "agent", deps, domain: "" })).toThrow(ZodError);
  });

  it("throws ZodError for non-string agentId (runtime coercion guard)", () => {
    expect(() =>
      buildSkills({
        // @ts-expect-error — testing runtime type rejection
        agentId: 42,
        deps,
        domain: "test",
      }),
    ).toThrow(ZodError);
  });
});

// ─── Duplicate detection ──────────────────────────────────────────────────────

describe("buildSkills — duplicate detection", () => {
  it("throws when extra collides with a base skill name", () => {
    expect(() =>
      buildSkills({
        agentId: "agent",
        deps,
        domain: "test",
        extras: [{ name: "brain-query", skill: makeExtraSkill("brain-query") }],
      }),
    ).toThrow(/collides with a base skill/);
  });

  it("throws when two extras share the same name", () => {
    const s = makeExtraSkill("dup");
    expect(() =>
      buildSkills({
        agentId: "agent",
        deps,
        domain: "test",
        extras: [
          { name: "dup", skill: s },
          { name: "dup", skill: s },
        ],
      }),
    ).toThrow(/duplicate extra skill IDs/);
  });
});

// ─── buildSkillRegistry convenience wrapper ───────────────────────────────────

describe("buildSkillRegistry", () => {
  it("returns the same registry as buildSkills().registry", () => {
    const opts = { agentId: "agent", deps, domain: "test" };
    const { registry } = buildSkills(opts);
    const registryDirect = buildSkillRegistry(opts);
    expect(Object.keys(registryDirect).sort()).toEqual(Object.keys(registry).sort());
  });
});

// ─── llm-complete skill ───────────────────────────────────────────────────────

describe("llm-complete skill", () => {
  it("is present in registry", () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    expect(registry["llm-complete"]).toBeDefined();
    expect(registry["llm-complete"]!.name).toBe("llm-complete");
  });

  it("replay=true returns mock without calling fetch", async () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    const skill = registry["llm-complete"]!;
    const ctx = makeCtx({
      isReplay: true,
      dryRunMocks: {
        "llm-complete": () => ({ content: "mock-response", raw: {} }),
      },
    });
    const result = await skill.execute({ systemPrompt: "sys", userPrompt: "usr" }, ctx);
    expect(result).toMatchObject({ content: "mock-response" });
  });

  it("replay=true with no mock returns empty content", async () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    const skill = registry["llm-complete"]!;
    const ctx = makeCtx({ isReplay: true });
    const result = await skill.execute({ systemPrompt: "sys", userPrompt: "usr" }, ctx);
    expect((result as { content: string }).content).toBe("");
  });

  it("live mode with no LITELLM_URL returns error in raw", async () => {
    // Ensure LITELLM_URL is unset
    const originalEnv = process.env.LITELLM_URL;
    delete process.env.LITELLM_URL;

    const { registry } = buildSkills({
      agentId: "a",
      deps: { logger: noopLogger, litellmUrl: undefined },
      domain: "d",
    });
    const skill = registry["llm-complete"]!;
    const ctx = makeCtx({ isReplay: false });

    const result = await skill.execute({ systemPrompt: "sys", userPrompt: "usr" }, ctx);
    expect((result as { content: string; raw: { error: string } }).content).toBe("");
    expect((result as { content: string; raw: { error: string } }).raw.error).toContain(
      "LITELLM_URL not configured",
    );

    if (originalEnv !== undefined) {
      process.env.LITELLM_URL = originalEnv;
    }
  });

  it("llm-complete inputSchema validates correctly", () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    const skill = registry["llm-complete"]!;
    const valid = skill.inputSchema.parse({
      systemPrompt: "sys",
      userPrompt: "usr",
    });
    expect(valid).toMatchObject({ systemPrompt: "sys", userPrompt: "usr" });
  });

  it("llm-complete inputSchema rejects unknown keys (strict)", () => {
    const { registry } = buildSkills({ agentId: "a", deps, domain: "d" });
    const skill = registry["llm-complete"]!;
    expect(() =>
      skill.inputSchema.parse({
        systemPrompt: "sys",
        userPrompt: "usr",
        unknownField: true,
      }),
    ).toThrow(ZodError);
  });
});

// ─── fetch mock — live LLM call ───────────────────────────────────────────────

describe("llm-complete live call (mocked fetch)", () => {
  it("returns content from mocked fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from llm" } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { registry } = buildSkills({
      agentId: "a",
      deps: { logger: noopLogger, litellmUrl: "http://litellm.local" },
      domain: "d",
    });
    const skill = registry["llm-complete"]!;
    const ctx = makeCtx({ isReplay: false });

    const result = await skill.execute({ systemPrompt: "sys", userPrompt: "usr" }, ctx);
    expect((result as { content: string }).content).toBe("hello from llm");
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
