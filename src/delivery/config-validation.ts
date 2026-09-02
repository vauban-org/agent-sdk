/**
 * delivery/config-validation.ts
 *
 * Content-grounded validation for the `config-valid` anchor: reads each config
 * file the producer declared and really parses it, instead of trusting the
 * artifact's own claim that the file exists and is well-formed.
 *
 * Same fail-closed posture as `grounded-tests.ts` (no reader wired == no seal),
 * and the same injected-I/O discipline: the reader is a {@link FileReader}
 * parameter, never a filesystem API called from here.
 *
 * @module delivery/config-validation
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseJson } from "./artifact-json.js";
import type { ConfigValidationResult, FileReader } from "./types.js";

/** Config file types recognized by `config-valid` (by extension), excluding Dockerfile. */
const RECOGNIZED_CONFIG_EXTS: ReadonlySet<string> = new Set([".yml", ".yaml", ".json"]);

/** Matches a real Dockerfile FROM instruction at the start of a line (case-insensitive). */
const RE_DOCKERFILE_FROM = /^\s*FROM\s+\S+/im;

/**
 * Content-grounded validation of the config files a developpement/verification
 * stage declared. The artifact (a JSON object) MUST carry `worktree` (abs path)
 * and a non-empty `files_changed` array. Each declared file is read from the
 * worktree and validated by type:
 *
 *   - *.yml / *.yaml      → parsed with the `yaml` package; a parse throw fails;
 *                            an empty / comment-only document (parses to
 *                            null/undefined) also fails (not a valid deliverable).
 *   - *.json              → JSON.parse; a parse throw fails.
 *   - Dockerfile / Dockerfile.* → MUST contain a FROM instruction (line-start).
 *   - any other extension → fail (not a recognized config file type).
 *
 * Security: each entry must be a non-empty RELATIVE path that resolves INSIDE the
 * worktree; an absolute path or a `../` escape fails closed (no arbitrary-file
 * read). A declared file that does not exist on disk (read throws) fails closed —
 * this is real signal that the producer did not write what it claimed.
 *
 * `ran` is false ONLY when the gate could not even attempt validation (no reader
 * wired, no worktree/files_changed, or unparseable artifact). A validation
 * FAILURE is `ran:true, valid:false` — it DID run. Mirrors the `runGroundedTests`
 * fail-closed posture (no reader == no seal, same as no executor == no seal).
 */
export function runConfigValidation(
  artifact: string,
  readFile: FileReader | undefined,
): ConfigValidationResult {
  const o = parseJson(artifact);
  if (!o) {
    return {
      ran: false,
      valid: false,
      rationale: "config-valid: artifact is not valid JSON (fail-closed)",
    };
  }
  const worktree = typeof o["worktree"] === "string" ? (o["worktree"] as string).trim() : "";
  const files = o["files_changed"];
  if (!worktree || !Array.isArray(files) || files.length === 0) {
    return {
      ran: false,
      valid: false,
      rationale:
        "config-valid: artifact must declare non-empty worktree + files_changed (fail-closed)",
    };
  }
  if (!readFile) {
    return {
      ran: false,
      valid: false,
      rationale: "config-valid: no file reader wired; cannot read worktree content (fail-closed)",
    };
  }
  const resolvedRoot = path.resolve(worktree);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  const classified: string[] = [];
  for (const entry of files) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return {
        ran: true,
        valid: false,
        rationale:
          "config-valid: files_changed contains an empty or non-string entry (fail-closed)",
      };
    }
    const base = path.basename(entry);
    // Path-traversal guard: reject absolute paths and any entry whose resolved
    // location escapes the worktree (e.g. "../evil.yml").
    if (path.isAbsolute(entry)) {
      return {
        ran: true,
        valid: false,
        rationale: `config-valid: file '${entry}' is an absolute path (escapes the worktree, fail-closed)`,
      };
    }
    const abs = path.resolve(resolvedRoot, entry);
    if (abs !== resolvedRoot && !abs.startsWith(rootPrefix)) {
      return {
        ran: true,
        valid: false,
        rationale: `config-valid: file '${entry}' escapes the worktree (fail-closed)`,
      };
    }
    // Read the declared file. A throw (missing/unreadable) fails closed.
    let content: string;
    try {
      content = readFile(abs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ran: true,
        valid: false,
        rationale: `config-valid: file '${base}' could not be read (fail-closed): ${msg}`,
      };
    }
    // Classify + validate by type.
    if (base === "Dockerfile" || base.startsWith("Dockerfile.")) {
      if (!RE_DOCKERFILE_FROM.test(content)) {
        return {
          ran: true,
          valid: false,
          rationale: `config-valid: Dockerfile '${base}' has no FROM instruction (fail-closed)`,
        };
      }
      classified.push(`${base}(dockerfile)`);
      continue;
    }
    const ext = path.extname(base).toLowerCase();
    if (ext === ".yml" || ext === ".yaml") {
      let parsed: unknown;
      try {
        parsed = parseYaml(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ran: true,
          valid: false,
          rationale: `config-valid: YAML '${base}' failed to parse (fail-closed): ${msg}`,
        };
      }
      // Empty / comment-only YAML parses to null/undefined: not a valid config.
      if (parsed === null || parsed === undefined) {
        return {
          ran: true,
          valid: false,
          rationale: `config-valid: YAML '${base}' is empty or contains no document (fail-closed)`,
        };
      }
      classified.push(`${base}(yaml)`);
      continue;
    }
    if (ext === ".json") {
      try {
        JSON.parse(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ran: true,
          valid: false,
          rationale: `config-valid: JSON '${base}' failed to parse (fail-closed): ${msg}`,
        };
      }
      classified.push(`${base}(json)`);
      continue;
    }
    if (!RECOGNIZED_CONFIG_EXTS.has(ext)) {
      return {
        ran: true,
        valid: false,
        rationale: `config-valid: file '${base}' is not a recognized config file type (expected: .yml, .yaml, .json, Dockerfile)`,
      };
    }
  }
  return {
    ran: true,
    valid: true,
    rationale: `${classified.length} config file(s) validated: [${classified.join(", ")}]`,
  };
}
