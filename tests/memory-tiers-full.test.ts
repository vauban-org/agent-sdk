/**
 * tests/memory-tiers-full.test.ts
 *
 * Sprint-564: C4 — Memory tiers semantic + procedural (complete A6).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryProceduralMemory, InMemorySemanticMemory } from "../src/ports/brain.js";

describe("InMemorySemanticMemory", () => {
  let sm: InMemorySemanticMemory;

  beforeEach(() => {
    sm = new InMemorySemanticMemory();
  });

  it("archives and queries shared knowledge", async () => {
    await sm.archive({
      content: "Starknet L2 scaling solution",
      category: "tech",
      tags: ["starknet"],
    });
    await sm.archive({ content: "Ethereum L1 base layer", category: "tech", tags: ["ethereum"] });

    const results = await sm.query("starknet");
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("Starknet");
  });

  it("filters by category", async () => {
    await sm.archive({ content: "a", category: "tech" });
    await sm.archive({ content: "b", category: "finance" });

    const results = await sm.query("a", { category: "tech" });
    expect(results).toHaveLength(1);
  });

  it("filters by tags", async () => {
    await sm.archive({ content: "x", tags: ["alpha"] });
    await sm.archive({ content: "y", tags: ["beta"] });

    const results = await sm.query("x", { tags: ["alpha"] });
    expect(results).toHaveLength(1);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await sm.archive({ content: `item ${i}` });
    }
    const results = await sm.query("item", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  describe("recall() — additive delegation to brainRecall (sprint-806, ADR-ECO-065)", () => {
    const originalBrainUrl = process.env.BRAIN_URL;

    afterEach(() => {
      if (originalBrainUrl === undefined) {
        delete process.env.BRAIN_URL;
      } else {
        process.env.BRAIN_URL = originalBrainUrl;
      }
    });

    it("degrades to a 'degraded' RecallResult when BRAIN_URL is unset (fail-soft, never throws)", async () => {
      delete process.env.BRAIN_URL;
      const result = await sm.recall("starknet", { tier: "auto", mode: "chunks" });
      expect(result.strategy_used).toBe("degraded");
      expect(result.chunks).toEqual([]);
    });
  });
});

describe("InMemoryProceduralMemory", () => {
  let pm: InMemoryProceduralMemory;

  beforeEach(() => {
    pm = new InMemoryProceduralMemory();
  });

  it("registers and resolves skills for an agent", async () => {
    await pm.registerSkill("agent-a", {
      name: "my-skill",
      description: "A learned skill",
      source: "learning-loop",
      confidence: 0.9,
    });

    const skills = await pm.resolveSkills("agent-a");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("my-skill");
  });

  it("shares skills between agents", async () => {
    await pm.registerSkill("agent-a", {
      name: "shared-tool",
      description: "A tool",
      source: "manual",
      confidence: 1.0,
    });

    await pm.shareSkill("shared-tool", "agent-a", ["agent-b", "agent-c"]);

    const skillsB = await pm.resolveSkills("agent-b");
    expect(skillsB).toHaveLength(1);
    expect(skillsB[0]!.source).toBe("shared");

    const skillsC = await pm.resolveSkills("agent-c");
    expect(skillsC).toHaveLength(1);
  });

  it("returns own + shared skills for an agent", async () => {
    await pm.registerSkill("agent-a", {
      name: "own-skill",
      description: "own",
      source: "manual",
      confidence: 1.0,
    });
    await pm.shareSkill("own-skill", "agent-a", ["agent-b"]);

    await pm.registerSkill("agent-b", {
      name: "b-skill",
      description: "b",
      source: "learning-loop",
      confidence: 0.8,
    });

    const skills = await pm.resolveSkills("agent-b");
    expect(skills).toHaveLength(2);
  });

  it("returns empty for unknown agent", async () => {
    const skills = await pm.resolveSkills("nonexistent");
    expect(skills).toHaveLength(0);
  });
});
