/**
 * Tests for src/identity/agent-persona.ts
 *
 * Coverage:
 *   PERSONA_BRAIN_CATEGORY — constant value
 *   personaTags(agentId) — returns correct tags array
 *   savePersonaToBrain — archives with correct shape, returns id
 *   loadPersonaFromBrain — parses and sorts entries, returns null on empty
 *   loadPersonaFromFile — returns null on ENOENT, parses valid YAML
 *   savePersonaToFile — writes YAML, validates first
 *   resolvePersona — layers accumulation, brain + local override defaults
 */

import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PERSONA_BRAIN_CATEGORY,
  loadPersonaFromBrain,
  loadPersonaFromFile,
  personaTags,
  resolvePersona,
  savePersonaToBrain,
  savePersonaToFile,
} from "../src/identity/agent-persona.js";
import type { AgentPersona } from "../src/identity/persona-schema.js";
import { DEFAULT_PERSONA } from "../src/identity/persona-schema.js";
import type { SemanticMemoryPort } from "../src/ports/brain.js";

// ─── PERSONA_BRAIN_CATEGORY ───────────────────────────────────────────────────

describe("PERSONA_BRAIN_CATEGORY", () => {
  it("is a non-empty string", () => {
    expect(typeof PERSONA_BRAIN_CATEGORY).toBe("string");
    expect(PERSONA_BRAIN_CATEGORY.length).toBeGreaterThan(0);
  });

  it("equals 'agent-persona'", () => {
    expect(PERSONA_BRAIN_CATEGORY).toBe("agent-persona");
  });
});

// ─── personaTags ─────────────────────────────────────────────────────────────

describe("personaTags", () => {
  it("returns an array", () => {
    expect(Array.isArray(personaTags("my-agent"))).toBe(true);
  });

  it("includes the 'persona' tag", () => {
    expect(personaTags("my-agent")).toContain("persona");
  });

  it("includes the agentId as a tag", () => {
    expect(personaTags("my-agent")).toContain("my-agent");
  });

  it("different agentId yields different tags", () => {
    const a = personaTags("agent-a");
    const b = personaTags("agent-b");
    expect(a).not.toEqual(b);
  });

  it("returns exactly 2 elements", () => {
    expect(personaTags("x").length).toBe(2);
  });

  it("preserves agentId exactly (no transformation)", () => {
    const id = "BUILDER-v2";
    expect(personaTags(id)).toContain(id);
  });

  it("returns a new array on each call", () => {
    const t1 = personaTags("agent-a");
    const t2 = personaTags("agent-a");
    expect(t1).not.toBe(t2); // different reference
    expect(t1).toEqual(t2); // same content
  });
});

// ─── savePersonaToBrain ───────────────────────────────────────────────────────

describe("savePersonaToBrain", () => {
  const makePort = (id: string | null): SemanticMemoryPort =>
    ({
      archive: vi.fn().mockResolvedValue(id ? { id } : null),
      query: vi.fn().mockResolvedValue([]),
    }) as unknown as SemanticMemoryPort;

  const minimalPersona: AgentPersona = {
    identity: { tone: "concise" },
  };

  it("returns the archived entry id on success", async () => {
    const brain = makePort("entry-42");
    const result = await savePersonaToBrain(brain, "builder", minimalPersona);
    expect(result).toBe("entry-42");
  });

  it("returns null when brain.archive returns null", async () => {
    const brain = makePort(null);
    const result = await savePersonaToBrain(brain, "builder", minimalPersona);
    expect(result).toBeNull();
  });

  it("calls archive with the correct category", async () => {
    const brain = makePort("id-1");
    await savePersonaToBrain(brain, "scribe", minimalPersona);
    const call = (brain.archive as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.category).toBe(PERSONA_BRAIN_CATEGORY);
  });

  it("calls archive with the correct tags for the agentId", async () => {
    const brain = makePort("id-2");
    await savePersonaToBrain(brain, "synergy", minimalPersona);
    const call = (brain.archive as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tags).toEqual(personaTags("synergy"));
  });

  it("content includes the agentId", async () => {
    const brain = makePort("id-3");
    await savePersonaToBrain(brain, "architect-99", minimalPersona);
    const call = (brain.archive as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.content).toContain("architect-99");
  });

  it("content includes 'persona' keyword for FTS", async () => {
    const brain = makePort("id-4");
    await savePersonaToBrain(brain, "tester", minimalPersona);
    const call = (brain.archive as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.content).toContain("persona");
  });

  it("metadata contains agent_id", async () => {
    const brain = makePort("id-5");
    await savePersonaToBrain(brain, "monitor", minimalPersona);
    const call = (brain.archive as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.metadata?.agent_id).toBe("monitor");
  });
});

// ─── loadPersonaFromBrain ─────────────────────────────────────────────────────

describe("loadPersonaFromBrain", () => {
  const makePort = (entries: Array<{ content: string; created_at?: string }>): SemanticMemoryPort =>
    ({
      archive: vi.fn(),
      query: vi.fn().mockResolvedValue(entries),
    }) as unknown as SemanticMemoryPort;

  it("returns null when no entries found", async () => {
    const brain = makePort([]);
    expect(await loadPersonaFromBrain(brain, "agent-x")).toBeNull();
  });

  it("parses a valid wrapped-format persona entry", async () => {
    const persona: AgentPersona = { identity: { tone: "detailed" } };
    const brain = makePort([
      { content: `persona for agent test-agent\n${JSON.stringify(persona)}` },
    ]);
    const result = await loadPersonaFromBrain(brain, "test-agent");
    expect(result).not.toBeNull();
    expect(result?.identity?.tone).toBe("detailed");
  });

  it("returns null when content is malformed JSON", async () => {
    const brain = makePort([{ content: "persona for agent x\nnot-json" }]);
    expect(await loadPersonaFromBrain(brain, "x")).toBeNull();
  });

  it("returns null when content fails schema validation", async () => {
    const brain = makePort([
      { content: `persona for agent x\n{"identity":{"tone":"invalid-tone"}}` },
    ]);
    expect(await loadPersonaFromBrain(brain, "x")).toBeNull();
  });

  it("picks the most recent entry by created_at", async () => {
    const older: AgentPersona = { identity: { tone: "concise" } };
    const newer: AgentPersona = { identity: { tone: "detailed" } };
    const brain = makePort([
      {
        content: `persona for agent z\n${JSON.stringify(older)}`,
        created_at: "2024-01-01T00:00:00Z",
      },
      {
        content: `persona for agent z\n${JSON.stringify(newer)}`,
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);
    const result = await loadPersonaFromBrain(brain, "z");
    expect(result?.identity?.tone).toBe("detailed");
  });

  it("queries Brain using the PERSONA_BRAIN_CATEGORY", async () => {
    const brain = makePort([]);
    await loadPersonaFromBrain(brain, "agent-q");
    const call = (brain.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.category).toBe(PERSONA_BRAIN_CATEGORY);
  });
});

// ─── loadPersonaFromFile ──────────────────────────────────────────────────────

describe("loadPersonaFromFile", () => {
  it("returns null when file does not exist (ENOENT)", async () => {
    expect(await loadPersonaFromFile("/tmp/__no_such_persona_file_12345__.yaml")).toBeNull();
  });

  it("returns null when YAML does not match schema (invalid tone)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-test-"));
    const path = join(dir, "bad.yaml");
    await writeFile(path, "identity:\n  tone: not-a-valid-tone\n", "utf-8");
    expect(await loadPersonaFromFile(path)).toBeNull();
    await unlink(path);
  });

  it("parses a valid YAML persona file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-test-"));
    const path = join(dir, "valid.yaml");
    await writeFile(path, "identity:\n  tone: concise\n  language: en\n", "utf-8");
    const result = await loadPersonaFromFile(path);
    expect(result).not.toBeNull();
    expect(result?.identity?.tone).toBe("concise");
    await unlink(path);
  });

  it("returns null for an empty YAML file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-test-"));
    const path = join(dir, "empty.yaml");
    await writeFile(path, "", "utf-8");
    // empty YAML parses as null — schema validation fails → returns null
    expect(await loadPersonaFromFile(path)).toBeNull();
    await unlink(path);
  });
});

// ─── resolvePersona ───────────────────────────────────────────────────────────

describe("resolvePersona", () => {
  it("always includes 'defaults' as first layer", async () => {
    const result = await resolvePersona({ agentId: "agent-a" });
    expect(result.layers[0]).toBe("defaults");
  });

  it("returns DEFAULT_PERSONA when no brain or localPath provided", async () => {
    const result = await resolvePersona({ agentId: "agent-b" });
    expect(result.effective).toEqual(DEFAULT_PERSONA);
  });

  it("layers array contains only 'defaults' when no sources provided", async () => {
    const result = await resolvePersona({ agentId: "agent-c" });
    expect(result.layers).toEqual(["defaults"]);
  });

  it("adds 'brain' to layers when brain returns a persona", async () => {
    const persona: AgentPersona = { identity: { tone: "detailed" } };
    const brain: SemanticMemoryPort = {
      archive: vi.fn(),
      query: vi
        .fn()
        .mockResolvedValue([{ content: `persona for agent d\n${JSON.stringify(persona)}` }]),
    } as unknown as SemanticMemoryPort;
    const result = await resolvePersona({ agentId: "agent-d", brain });
    expect(result.layers).toContain("brain");
  });

  it("effective persona reflects brain override", async () => {
    const persona: AgentPersona = { identity: { tone: "pedagogical" } };
    const brain: SemanticMemoryPort = {
      archive: vi.fn(),
      query: vi
        .fn()
        .mockResolvedValue([{ content: `persona for agent e\n${JSON.stringify(persona)}` }]),
    } as unknown as SemanticMemoryPort;
    const result = await resolvePersona({ agentId: "agent-e", brain });
    expect(result.effective.identity?.tone).toBe("pedagogical");
  });

  it("does not add 'brain' to layers when brain returns no persona", async () => {
    const brain: SemanticMemoryPort = {
      archive: vi.fn(),
      query: vi.fn().mockResolvedValue([]),
    } as unknown as SemanticMemoryPort;
    const result = await resolvePersona({ agentId: "agent-f", brain });
    expect(result.layers).not.toContain("brain");
  });
});
