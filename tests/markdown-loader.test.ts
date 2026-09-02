/**
 * Tests for agent-sdk/src/skills/poc-md-loader/markdown-loader.ts
 *
 * Coverage:
 *   SkillManifestSchema — valid manifest, name kebab-case, missing required fields,
 *                         unknown fields rejected (.strict()), metadata defaults
 *   loadSkillMd — missing frontmatter throws, invalid frontmatter throws,
 *                 valid file parses name/description/body,
 *                 metadata nested object parsed, folded scalar (>) parsed
 *
 * Ref: test coverage for agent-sdk/skills/poc-md-loader/markdown-loader.ts (no prior tests)
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillManifestSchema, loadSkillMd } from "../src/skills/poc-md-loader/markdown-loader.js";

// ─── SkillManifestSchema ─────────────────────────────────────────────────────

describe("SkillManifestSchema", () => {
  it("accepts minimal valid manifest", () => {
    const result = SkillManifestSchema.safeParse({
      name: "web-search",
      description: "Search the web",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full manifest with metadata", () => {
    const result = SkillManifestSchema.safeParse({
      name: "my-skill",
      description: "Does something useful",
      "allowed-tools": "Bash(curl:*) Read",
      metadata: {
        version: "1.2.0",
        category: "search",
        tags: "web,http",
        "model-hint": "haiku",
        "env-required": "API_KEY",
        "env-mode": "all",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects name with uppercase letters", () => {
    const result = SkillManifestSchema.safeParse({
      name: "MySkill",
      description: "bad name",
    });
    expect(result.success).toBe(false);
  });

  it("rejects name with underscores (not kebab)", () => {
    const result = SkillManifestSchema.safeParse({
      name: "my_skill",
      description: "bad name",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = SkillManifestSchema.safeParse({
      name: "",
      description: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields (.strict())", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "ok",
      unknownField: "bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid env-mode value", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "ok",
      metadata: { "env-mode": "none" },
    });
    expect(result.success).toBe(false);
  });

  it("metadata version defaults to '1.0.0' when omitted", () => {
    const result = SkillManifestSchema.safeParse({
      name: "test",
      description: "ok",
      metadata: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata?.version).toBe("1.0.0");
    }
  });
});

// ─── loadSkillMd ─────────────────────────────────────────────────────────────

const tmpFiles: string[] = [];

async function writeTmpSkill(content: string): Promise<string> {
  const path = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  await writeFile(path, content, "utf-8");
  tmpFiles.push(path);
  return path;
}

afterEach(() => {
  tmpFiles.length = 0;
});

describe("loadSkillMd", () => {
  it("parses a minimal valid SKILL.md file", async () => {
    const path = await writeTmpSkill(
      "---\nname: web-search\ndescription: Search the web\n---\n## Usage\nJust call it.\n",
    );
    const { manifest, body } = await loadSkillMd(path);
    expect(manifest.name).toBe("web-search");
    expect(manifest.description).toBe("Search the web");
    expect(body).toContain("## Usage");
  });

  it("throws when frontmatter delimiters are missing", async () => {
    const path = await writeTmpSkill("name: web-search\ndescription: test\n");
    await expect(loadSkillMd(path)).rejects.toThrow("frontmatter");
  });

  it("throws when Zod validation fails (invalid name)", async () => {
    const path = await writeTmpSkill("---\nname: MyBadName\ndescription: test\n---\nsome body\n");
    await expect(loadSkillMd(path)).rejects.toThrow("invalid frontmatter");
  });

  it("parses nested metadata object", async () => {
    const path = await writeTmpSkill(
      "---\nname: my-skill\ndescription: does stuff\nmetadata:\n  version: 2.0.0\n  category: tools\n---\nbody\n",
    );
    const { manifest } = await loadSkillMd(path);
    expect(manifest.metadata?.version).toBe("2.0.0");
    expect(manifest.metadata?.category).toBe("tools");
  });

  it("parses allowed-tools field", async () => {
    const path = await writeTmpSkill(
      "---\nname: bash-skill\ndescription: runs bash\nallowed-tools: Bash(curl:*) Read\n---\nbody\n",
    );
    const { manifest } = await loadSkillMd(path);
    expect(manifest["allowed-tools"]).toBe("Bash(curl:*) Read");
  });

  it("body is trimmed", async () => {
    const path = await writeTmpSkill(
      "---\nname: trim-test\ndescription: test\n---\n\n  content here  \n\n",
    );
    const { body } = await loadSkillMd(path);
    expect(body).toBe("content here");
  });

  it("parses folded scalar (>) in frontmatter", async () => {
    const path = await writeTmpSkill(
      "---\nname: folded-test\ndescription: >\n  line one\n  line two\n---\nbody\n",
    );
    const { manifest } = await loadSkillMd(path);
    expect(manifest.description).toBe("line one line two");
  });
});
