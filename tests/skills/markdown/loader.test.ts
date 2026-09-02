/**
 * Tests for the SKILL.md loader.
 *
 * Coverage:
 *   - Nominal parse (agentskills.io spec) — fields, multi-line description, body
 *   - Vauban extensions under metadata.vauban.*
 *   - Validation errors: name, description, allowed-tools, tier enum
 *   - Parse errors: missing delimiters, malformed YAML, root array
 *   - Tier resolution defaults to "unverified"
 *   - parseAllowedTools whitespace handling
 *   - Discovery projection
 *
 * @see ../loader.ts
 * @see ../schema.ts
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillMdParseError, SkillMdValidationError } from "../../../src/skills/errors.js";
import {
  loadSkillMd,
  parseSkillMd,
  toDiscoveryEntry,
} from "../../../src/skills/markdown/loader.js";
import { parseAllowedTools, resolveTier } from "../../../src/skills/markdown/schema.js";

const NOMINAL_SKILL = `---
name: starknet-validator
description: Monitor Pathfinder node health, sync lag, peer count.
license: MIT
allowed-tools: "Bash(curl:*) Bash(jq:*) Read"
metadata:
  version: "2.1.0"
  category: blockchain
  tags: [starknet, validator, monitoring]
  author: vauban-core
  vauban:
    tier: official
    subagent: starknet-ops
    model-hint: haiku
    proof:
      poseidon_hash: "0x1234abcd"
      starknet_tx: "0xdeadbeef"
    biscuit:
      required_caps:
        - fs.read:project
        - mcp.call:starknet.*
      max_scope: project
    audit_status: approved
---

# starknet-validator

Body content goes here.
`;

describe("parseSkillMd — nominal", () => {
  it("parses a fully populated SKILL.md", () => {
    const parsed = parseSkillMd(NOMINAL_SKILL);
    expect(parsed.manifest.name).toBe("starknet-validator");
    expect(parsed.manifest.description).toContain("Monitor Pathfinder");
    expect(parsed.manifest.license).toBe("MIT");
    expect(parsed.manifest["allowed-tools"]).toContain("Bash(curl:*)");
    expect(parsed.tier).toBe("official");
    expect(parsed.body).toContain("# starknet-validator");
    expect(parsed.bodyTokens).toBeGreaterThan(0);
  });

  it("parses Vauban metadata extensions", () => {
    const parsed = parseSkillMd(NOMINAL_SKILL);
    const vauban = parsed.manifest.metadata?.vauban;
    expect(vauban?.tier).toBe("official");
    expect(vauban?.subagent).toBe("starknet-ops");
    expect(vauban?.["model-hint"]).toBe("haiku");
    expect(vauban?.proof?.poseidon_hash).toBe("0x1234abcd");
    expect(vauban?.proof?.starknet_tx).toBe("0xdeadbeef");
    expect(vauban?.biscuit?.required_caps).toEqual(["fs.read:project", "mcp.call:starknet.*"]);
    expect(vauban?.biscuit?.max_scope).toBe("project");
    expect(vauban?.audit_status).toBe("approved");
  });

  it("parses arbitrary metadata keys (passthrough)", () => {
    const skill = `---
name: foo
description: bar
metadata:
  some-custom-key: hello
  another:
    nested: world
---

body
`;
    const parsed = parseSkillMd(skill);
    expect(parsed.manifest.metadata).toMatchObject({
      "some-custom-key": "hello",
      another: { nested: "world" },
    });
  });

  it("parses multi-line description via YAML folded scalar", () => {
    const skill = `---
name: foo
description: >
  Line one
  continues onto line two.
---

body
`;
    const parsed = parseSkillMd(skill);
    expect(parsed.manifest.description).toMatch(/Line one\s+continues onto line two\./);
  });

  it("trims body whitespace", () => {
    const skill = `---
name: foo
description: bar
---


  hello world


`;
    const parsed = parseSkillMd(skill);
    expect(parsed.body).toBe("hello world");
  });

  it("defaults tier to 'unverified' when absent", () => {
    const skill = `---
name: foo
description: bar
---

body
`;
    const parsed = parseSkillMd(skill);
    expect(parsed.tier).toBe("unverified");
    expect(resolveTier(parsed.manifest)).toBe("unverified");
  });
});

describe("parseSkillMd — validation errors", () => {
  it("rejects name with uppercase (not kebab-case)", () => {
    const skill = `---
name: BadName
description: bar
---

body
`;
    expect(() => parseSkillMd(skill, "f1.md")).toThrow(SkillMdValidationError);
  });

  it("rejects name with underscores", () => {
    const skill = `---
name: bad_name
description: bar
---

body
`;
    expect(() => parseSkillMd(skill, "f2.md")).toThrow(SkillMdValidationError);
  });

  it("rejects empty description", () => {
    const skill = `---
name: foo
description: ""
---

body
`;
    expect(() => parseSkillMd(skill, "f3.md")).toThrow(SkillMdValidationError);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const skill = `---
name: foo
description: bar
unexpected-top-level: hello
---

body
`;
    expect(() => parseSkillMd(skill, "f4.md")).toThrow(SkillMdValidationError);
  });

  it("rejects invalid vauban.tier value", () => {
    const skill = `---
name: foo
description: bar
metadata:
  vauban:
    tier: super-secret
---

body
`;
    expect(() => parseSkillMd(skill, "f5.md")).toThrow(SkillMdValidationError);
  });

  it("rejects malformed Poseidon hash (non-hex)", () => {
    const skill = `---
name: foo
description: bar
metadata:
  vauban:
    proof:
      poseidon_hash: "not-hex"
---

body
`;
    expect(() => parseSkillMd(skill, "f6.md")).toThrow(SkillMdValidationError);
  });

  it("validation error exposes typed issues", () => {
    const skill = `---
name: BadName
description: ""
---

body
`;
    try {
      parseSkillMd(skill, "f7.md");
      expect.fail("expected validation error");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillMdValidationError);
      const e = err as SkillMdValidationError;
      expect(e.issues.length).toBeGreaterThanOrEqual(2);
      expect(e.filePath).toBe("f7.md");
    }
  });
});

describe("parseSkillMd — parse errors", () => {
  it("rejects content without frontmatter delimiters", () => {
    expect(() => parseSkillMd("just body, no fm", "p1.md")).toThrow(SkillMdParseError);
  });

  it("rejects malformed YAML in frontmatter", () => {
    const skill = `---
name: foo
description: : : malformed yaml
  bad indent
---

body
`;
    expect(() => parseSkillMd(skill, "p2.md")).toThrow(SkillMdParseError);
  });

  it("rejects root-array frontmatter", () => {
    const skill = `---
- foo
- bar
---

body
`;
    expect(() => parseSkillMd(skill, "p3.md")).toThrow(SkillMdParseError);
  });
});

describe("parseAllowedTools", () => {
  it("returns empty array when allowed-tools absent", () => {
    const parsed = parseSkillMd(`---
name: foo
description: bar
---

body
`);
    expect(parseAllowedTools(parsed.manifest)).toEqual([]);
  });

  it("splits space-separated tools", () => {
    const parsed = parseSkillMd(`---
name: foo
description: bar
allowed-tools: "Bash(curl:*) Read"
---

body
`);
    expect(parseAllowedTools(parsed.manifest)).toEqual(["Bash(curl:*)", "Read"]);
  });

  it("collapses whitespace runs", () => {
    const parsed = parseSkillMd(`---
name: foo
description: bar
allowed-tools: "Bash(curl:*)   Read    Bash(jq:*)"
---

body
`);
    expect(parseAllowedTools(parsed.manifest)).toEqual(["Bash(curl:*)", "Read", "Bash(jq:*)"]);
  });
});

describe("toDiscoveryEntry", () => {
  it("projects to discovery-tier fields only", () => {
    const parsed = parseSkillMd(NOMINAL_SKILL);
    const disc = toDiscoveryEntry(parsed);
    expect(disc).toEqual({
      name: "starknet-validator",
      description: expect.stringContaining("Monitor Pathfinder"),
      tier: "official",
    });
  });
});

describe("loadSkillMd — disk", () => {
  it("loads a real SKILL.md file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-md-test-"));
    const path = join(dir, "SKILL.md");
    await writeFile(path, NOMINAL_SKILL, "utf-8");
    const parsed = await loadSkillMd(path);
    expect(parsed.manifest.name).toBe("starknet-validator");
    expect(parsed.tier).toBe("official");
  });

  it("surfaces SkillMdParseError with the file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-md-test-"));
    const path = join(dir, "broken.md");
    await writeFile(path, "no frontmatter here", "utf-8");
    await expect(loadSkillMd(path)).rejects.toThrow(SkillMdParseError);
  });
});
