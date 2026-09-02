/**
 * world-state-hash — definitive loop detection via state-hash collisions.
 *
 * Distinct from `createCoherenceDetector` (heuristic, window-based): when
 * the SAME (tool_name, canonicalised_args, canonicalised_output) tuple
 * appears twice in one session, the agent is definitively cycling through
 * the same world state. Exit immediately with stopReason="loop_definitive".
 *
 * Hash is computed on a CANONICAL form of the output (not raw) so that
 * spurious noise (timestamps, random IDs, ANSI codes) does not produce a
 * false negative. Structurally identical operations produce the same hash.
 *
 * Reference: "Dynamics of Agentic Loops" (arXiv:2512.10350) — oscillatory
 * regime detection via discrete state-space transitions. O(1) lookup, no
 * model cost, no embedding required.
 */

import { createHash } from "node:crypto";

/**
 * Tools that are pure reads — revisiting them is legitimate exploration.
 * Collisions for these tools are only flagged if the repeat happens within
 * READ_TOOL_MIN_DISTANCE steps. Write tools use WRITE_TOOL_MIN_DISTANCE.
 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_directory",
  "list_files",
  "search_files",
  "grep",
  "glob",
  "ls",
]);

/**
 * Minimum step gap required before a repeat is flagged as loop_definitive.
 * Reads: require repetition within 5 steps to flag (exploration revisits OK).
 * Writes: require repetition within 12 steps to flag (more sensitive).
 */
const READ_TOOL_MIN_DISTANCE = 5;
const WRITE_TOOL_MIN_DISTANCE = 12;

/** Bash commands that are purely read-only — get the same lenient treatment. */
const READ_BASH_PREFIXES = [
  "ls",
  "cat ",
  "head ",
  "tail ",
  "find ",
  "grep ",
  "wc ",
  "stat ",
  "file ",
  "pwd",
  "echo ",
  "which ",
  "type ",
  "env",
  "printenv",
  "ps ",
  "lsof ",
  "ss ",
  "netstat ",
  "df ",
  "du ",
  "id ",
  "whoami",
  "uname ",
  "hostname",
  "date",
];

/**
 * Extract the first "simple" command from a compound shell expression.
 * Handles `cmd1 && cmd2`, `cmd1 | cmd2`, `cmd1 ; cmd2`.
 * Returns the trimmed first token before any operator.
 */
function firstSimpleCommand(cmd: string): string {
  return cmd.split(/&&|[|;]/)[0]?.trimStart() ?? cmd.trimStart();
}

export function isReadOnlyTool(toolName: string, args: unknown): boolean {
  if (READ_ONLY_TOOLS.has(toolName)) return true;
  if (toolName === "run_bash" || toolName === "bash" || toolName === "execute_bash") {
    const rawCmd =
      typeof args === "object" && args !== null && "command" in (args as Record<string, unknown>)
        ? String((args as Record<string, string>).command).trimStart()
        : "";
    // For compound commands, classify by the first simple command
    const cmd = firstSimpleCommand(rawCmd);
    return READ_BASH_PREFIXES.some((prefix) => cmd.startsWith(prefix));
  }
  return false;
}

/**
 * Stateful tracker for world-state hashes within a single agent session.
 * Construct fresh per session; never share across sessions.
 *
 * A collision is only flagged as loop_definitive when the same (tool, args,
 * output) hash repeats within minRepeatDistance steps — preventing false
 * positives from legitimate "do lots of work, then re-read the same file"
 * exploration patterns. Genuine loops (same call 2–3 steps later) are still
 * caught immediately.
 * @public
 */
export class WorldStateHashTracker {
  /** Map from hash → first observed step index. */
  private readonly seen = new Map<string, number>();
  /** Optional reverse map for debug/telemetry (hash → {step, tool}). */
  private readonly history: Array<{
    step: number;
    tool: string;
    hash: string;
  }> = [];

  /**
   * Record a tool call + result and return whether this exact world state
   * has been seen before in the current session.
   *
   * @param toolName name of the tool invoked
   * @param args canonical args (will be sorted-key JSON-stringified)
   * @param outputSummary first ~200 chars of the tool result (raw)
   * @param stepIndex current step in the loop (for telemetry)
   * @returns object describing whether collision occurred and the hash
   */
  observe(
    toolName: string,
    args: unknown,
    outputSummary: string,
    stepIndex: number,
  ): { isCollision: boolean; hash: string; previousStep?: number } {
    const hash = canonicalStateHash(toolName, args, outputSummary);
    const previousStep = this.seen.get(hash);

    if (previousStep !== undefined) {
      const distance = stepIndex - previousStep;
      const minDistance = isReadOnlyTool(toolName, args)
        ? READ_TOOL_MIN_DISTANCE
        : WRITE_TOOL_MIN_DISTANCE;

      if (distance <= minDistance) {
        return { isCollision: true, hash, previousStep };
      }
      // Gap is large enough — treat as legitimate revisit, update the step
      this.seen.set(hash, stepIndex);
      this.history.push({ step: stepIndex, tool: toolName, hash });
      return { isCollision: false, hash };
    }

    this.seen.set(hash, stepIndex);
    this.history.push({ step: stepIndex, tool: toolName, hash });
    return { isCollision: false, hash };
  }

  /** Number of distinct world states observed. */
  get size(): number {
    return this.seen.size;
  }

  /** For telemetry: last N entries with their step/tool/hash. */
  recent(n = 10): ReadonlyArray<{ step: number; tool: string; hash: string }> {
    return this.history.slice(-n);
  }
}

/**
 * Compute a deterministic hash of (toolName, args, outputSummary).
 *
 * Args are JSON-stringified with sorted keys (stable across runs).
 * Output is normalized: trimmed, lowercased, stripped of ISO timestamps,
 * UUIDs, and ANSI escapes — these are noise that should not differentiate
 * structurally identical operations.
 *
 * Returns the first 32 hex chars of SHA-256 (128-bit; collision probability
 * negligible within a single session).
 * @public
 */
export function canonicalStateHash(toolName: string, args: unknown, outputSummary: string): string {
  const canonArgs = canonicalJSON(args);
  const canonOutput = canonicaliseOutput(outputSummary);
  const input = `${toolName}\x00${canonArgs}\x00${canonOutput}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** JSON.stringify with deeply sorted keys + array element order preserved. */
function canonicalJSON(v: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (val: unknown): unknown => {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val as object)) return "[circular]";
    seen.add(val as object);
    if (Array.isArray(val)) return val.map(walk);
    const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const sorted: Record<string, unknown> = {};
    for (const [k, v2] of entries) sorted[k] = walk(v2);
    return sorted;
  };
  try {
    return JSON.stringify(walk(v));
  } catch {
    return String(v);
  }
}

/**
 * Strip noise from tool output before hashing:
 * - ANSI escapes
 * - ISO 8601 timestamps
 * - UUIDs (any version)
 * - Hex-encoded ids of 16+ chars
 * - Trim to first 200 chars, lowercase
 */
function canonicaliseOutput(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences (U+001B) for stable hashing.
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(
        /\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?/g,
        "<TS>",
      )
      .replace(
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        "<UUID>",
      )
      .replace(/[0-9a-fA-F]{16,}/g, "<HEX>")
      .slice(0, 200)
      .toLowerCase()
      .trim()
  );
}
