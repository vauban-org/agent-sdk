/**
 * runner — prototype SKILL.md execution harness.
 *
 * Loads a SKILL.md manifest, validates env requirements,
 * dynamically imports the companion script.ts, and executes it.
 *
 * No integration with SkillRegistry — standalone POC harness only.
 *
 * @poc-jetable
 */

import { join } from "node:path";
import { type SkillManifest, loadSkillMd } from "./markdown-loader.js";

export interface RunnerResult<T = unknown> {
  output: T;
  manifest: SkillManifest;
  coldStartMs: number;
}

/**
 * Run a SKILL.md skill by directory path.
 *
 * @param skillDir  Absolute path to directory containing SKILL.md + script.ts
 * @param input     Raw input object passed to script.execute()
 */
export async function runSkillMd<T = unknown>(
  skillDir: string,
  input: unknown,
): Promise<RunnerResult<T>> {
  const t0 = performance.now();

  // Step 1: Load + validate SKILL.md
  const skillMdPath = join(skillDir, "SKILL.md");
  const { manifest } = await loadSkillMd(skillMdPath);

  // Step 2: Check env requirements
  const envRequired = manifest.metadata?.["env-required"];
  const envMode = manifest.metadata?.["env-mode"] ?? "all";
  if (envRequired) {
    const keys = envRequired.split(" ").filter(Boolean);
    const missing = keys.filter((k) => !process.env[k]);
    if (envMode === "all" && missing.length > 0) {
      throw new Error(`Skill '${manifest.name}': missing required env vars: ${missing.join(", ")}`);
    }
    if (envMode === "at-least-one" && missing.length === keys.length) {
      throw new Error(`Skill '${manifest.name}': at least one of ${keys.join(", ")} must be set`);
    }
  }

  // Step 3: Dynamic import of companion script
  const scriptPath = join(skillDir, "script.js");
  // In test context (tsx/ts-node), import .ts directly; in compiled, import .js
  let scriptModule: { execute: (input: unknown) => Promise<T> };
  try {
    scriptModule = (await import(scriptPath)) as typeof scriptModule;
  } catch {
    // Fallback: try .ts extension (tsx / ts-node context)
    const scriptTsPath = join(skillDir, "script.ts");
    scriptModule = (await import(scriptTsPath)) as typeof scriptModule;
  }

  if (typeof scriptModule.execute !== "function") {
    throw new Error(`Skill '${manifest.name}': script must export an execute() function`);
  }

  // Step 4: Execute
  const output = await scriptModule.execute(input);
  const coldStartMs = performance.now() - t0;

  return { output, manifest, coldStartMs };
}
