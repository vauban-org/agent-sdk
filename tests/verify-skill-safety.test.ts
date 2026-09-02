/**
 * tests/verify-skill-safety.test.ts
 *
 * The write-time skill-safety lens (Wave 2). Deterministic, no LLM. Builds real
 * ParsedSkillFile inputs via parseSkillMd and asserts the syntactic gate:
 * unknown tool refs, TODO/placeholder scaffolding, and degenerate bodies are
 * denied ; a clean skill passes.
 */

import { describe, expect, it } from "vitest";
import { parseSkillMd } from "../src/skills/markdown/loader.js";
import { skillSafetyDeny, skillSafetyLens } from "../src/verify/verifiers/skill-safety.js";

const KNOWN = new Set(["read_file", "list_directory"]);

const CLEAN = `---
name: summarize-logs
description: Summarize a log file into key events and errors.
allowed-tools: read_file list_directory
---
When asked to summarize logs, read the file, extract errors and warnings, and
produce a concise bullet summary grouped by severity. Cite line numbers for each
finding so the user can verify the result independently.
`;

const WITH_TODO = `---
name: do-thing
description: A skill that does the thing.
allowed-tools: read_file
---
TODO: describe the steps here. Read the file and then do the rest of the work.
`;

const UNKNOWN_TOOL = `---
name: bad-tool-ref
description: References a tool that does not exist in the registry.
allowed-tools: nonexistent_tool
---
This skill does real work across several lines so the body is not degenerate and
only the unknown tool reference triggers the denial path here.
`;

const DEGENERATE = `---
name: thin
description: Too thin to be a real skill.
allowed-tools: read_file
---
hi
`;

describe("skillSafetyLens / skillSafetyDeny (write-time)", () => {
  it("passes a clean skill (real tools, substantial body, no placeholders)", () => {
    const parsed = parseSkillMd(CLEAN);
    expect(skillSafetyDeny(parsed, KNOWN)).toEqual([]);
    const lens = skillSafetyLens({ knownTools: KNOWN });
    const r = lens.verifier.evaluate(parsed);
    expect(r).toMatchObject({ score: 1 });
  });

  it("denies a skill with TODO/placeholder scaffolding in the body", () => {
    const parsed = parseSkillMd(WITH_TODO);
    const denies = skillSafetyDeny(parsed, KNOWN);
    expect(denies.some((d) => /placeholder|scaffold|TODO/i.test(d))).toBe(true);
    expect(skillSafetyLens({ knownTools: KNOWN }).verifier.evaluate(parsed)).toMatchObject({
      score: 0,
    });
  });

  it("denies a skill referencing an unknown tool", () => {
    const parsed = parseSkillMd(UNKNOWN_TOOL);
    const denies = skillSafetyDeny(parsed, KNOWN);
    expect(denies.some((d) => /unknown tools/.test(d))).toBe(true);
  });

  it("denies a degenerate (too-thin) body", () => {
    const parsed = parseSkillMd(DEGENERATE);
    const denies = skillSafetyDeny(parsed, KNOWN);
    expect(denies.some((d) => /too thin/.test(d))).toBe(true);
  });

  it("is a hard affirm rule lens (the deterministic anchor)", () => {
    const lens = skillSafetyLens({ knownTools: KNOWN });
    expect(lens.polarity).toBe("affirm");
    expect(lens.criticality).toBe("hard");
    expect(lens.signature.engine).toBe("rule");
  });
});
