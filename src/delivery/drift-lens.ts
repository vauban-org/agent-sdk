/**
 * delivery/drift-lens.ts
 *
 * Builds the drift-scope BatteryLens for the delivery factory dual-twin.
 *
 * This lens is the SECOND INDEPENDENT ATTESTATION in the dual-twin pattern:
 * a distinct Ed25519 signer attests that a REAL git diff computation ran and
 * every changed file belongs to the scope declared by the frozen intention.
 *
 * The lens is:
 *   - name: "anti-drift-scope"
 *   - criticality: "hard"
 *   - polarity: "affirm"
 *   - engine: "rule" (pure deterministic prefix-match) or "execution" (git diff)
 *   - NEVER llm-judge
 *
 * Fail-closed on every invalid input: missing intent, empty allowed_paths,
 * non-absolute worktree, non-hex refs, missing exec, git error.
 *
 * Security: zero-trust on every input field (same discipline as
 * validateTestCommand). No unvalidated value is passed to exec.
 *
 * @module delivery/drift-lens
 */

import { isAbsolute } from "node:path";
import type { BatteryLens } from "../compute/battery/types.js";
import type { ExecFn } from "./types.js";

// ─── Anchor id ─────────────────────────────────────────────────────────────────

/** The single anchor id this lens asserts. Must match the citadel side exactly. */
export const DRIFT_ANCHOR_ID = "anti-drift-scope";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Frozen intention delivered by the stage context. Only the drift-relevant
 * fragment is required here; extra fields are ignored (open schema, data layer).
 */
export interface FrozenIntent {
  /** Allowed path prefixes. Every changed file must match at least one. */
  readonly scope?: {
    readonly allowed_paths?: readonly string[];
  };
}

/**
 * The artifact produced by the build stage. Must declare the git worktree and
 * the before/after refs of the diff to inspect.
 */
export interface DriftArtifact {
  /** Absolute path to the git worktree root. */
  readonly worktree?: string;
  /** Base commit ref (hex, 7-40 chars). */
  readonly diff_base?: string;
  /** Head commit ref (hex, 7-40 chars). */
  readonly diff_head?: string;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

/** Strict hex ref pattern: 7-40 lowercase hex chars, no other content. */
const HEX_REF_RE = /^[0-9a-f]{7,40}$/;

function isHexRef(s: unknown): s is string {
  return typeof s === "string" && HEX_REF_RE.test(s);
}

/**
 * Normalise a path returned by git diff --name-only.
 * Returns null if the path is absolute or contains a ../ traversal (injection).
 */
function normaliseGitPath(p: string): string | null {
  if (isAbsolute(p)) return null;
  // Reject ../ traversals anywhere in the path.
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "..") return null;
  }
  return p;
}

/**
 * Return true when `filePath` matches at least one allowed prefix from
 * `allowedPaths`. Prefix match: filePath starts with the prefix exactly
 * (case-sensitive, no glob, no regex). A trailing slash on the prefix is
 * tolerated and normalised away before comparison.
 */
function matchesAllowedPrefix(filePath: string, allowedPaths: readonly string[]): boolean {
  for (const raw of allowedPaths) {
    const prefix = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (filePath === prefix || filePath.startsWith(prefix + "/")) return true;
  }
  return false;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Build the drift-scope BatteryLens.
 *
 * @param intent - The frozen intention object (must carry scope.allowed_paths).
 * @param artifact - The build-stage artifact (must carry worktree, diff_base,
 *   diff_head).
 * @param exec - Injected command executor (the module's ExecFn contract, see
 *   `delivery/types.ts`). Without it the lens fails closed.
 * @param expectedHead - The commit from the primary gate envelope (hex strict
 *   7-40 chars). The lens FAILS if artifact.diff_head !== expectedHead.
 *   If expectedHead is not a valid hex ref (e.g. "unknown"), the lens FAILS
 *   fail-closed: a drift attestation in production requires a real commit.
 *   Fix DETTES-1 (2026-06-11, spec 1.3): closes debt 15b.
 */
export function buildDriftLens(
  intent: FrozenIntent | null | undefined,
  artifact: DriftArtifact | null | undefined,
  exec: ExecFn | undefined,
  expectedHead?: string,
): BatteryLens<string> {
  // Capture everything at construction time so the returned lens is a pure
  // closure; the battery calls evaluate(candidate) later.
  const capturedIntent = intent;
  const capturedArtifact = artifact;
  const capturedExec = exec;
  const capturedExpectedHead = expectedHead;

  return {
    verifier: {
      name: DRIFT_ANCHOR_ID,
      evaluate: (_candidate: string) => {
        // ── Input validation (fail-closed on every invalid field) ─────────

        if (!capturedIntent) {
          return {
            score: 0,
            rationale: "anti-drift-scope: intent is absent (fail-closed)",
          };
        }

        const allowedPaths = capturedIntent.scope?.allowed_paths;
        if (!allowedPaths || allowedPaths.length === 0) {
          return {
            score: 0,
            rationale:
              "anti-drift-scope: intent.scope.allowed_paths is absent or empty (fail-closed)",
          };
        }

        if (!capturedArtifact) {
          return {
            score: 0,
            rationale: "anti-drift-scope: artifact is absent (fail-closed)",
          };
        }

        const worktree = capturedArtifact.worktree;
        if (!worktree || !isAbsolute(worktree)) {
          return {
            score: 0,
            rationale: `anti-drift-scope: artifact.worktree must be an absolute path (got ${JSON.stringify(worktree)}; fail-closed)`,
          };
        }

        const diffBase = capturedArtifact.diff_base;
        if (!isHexRef(diffBase)) {
          return {
            score: 0,
            rationale: `anti-drift-scope: artifact.diff_base must be a 7-40 char lowercase hex ref (got ${JSON.stringify(diffBase)}; fail-closed; injection rejected)`,
          };
        }

        const diffHead = capturedArtifact.diff_head;
        if (!isHexRef(diffHead)) {
          return {
            score: 0,
            rationale: `anti-drift-scope: artifact.diff_head must be a 7-40 char lowercase hex ref (got ${JSON.stringify(diffHead)}; fail-closed; injection rejected)`,
          };
        }

        // expectedHead binding (DETTES-1 fix, spec 1.3, 2026-06-11):
        // bind diff_head to the gated envelope commit.
        if (capturedExpectedHead !== undefined) {
          if (!isHexRef(capturedExpectedHead)) {
            return {
              score: 0,
              rationale: `anti-drift-scope: cannot bind drift to a non-hex gated commit (got ${JSON.stringify(capturedExpectedHead)}; fail-closed)`,
            };
          }
          if (diffHead !== capturedExpectedHead) {
            return {
              score: 0,
              rationale: `anti-drift-scope: drift range head does not match the gated commit (artifact.diff_head=${JSON.stringify(diffHead)}, expectedHead=${JSON.stringify(capturedExpectedHead)}; fail-closed)`,
            };
          }
        }

        // Vacuous-range guard (twin finding, run 15/16): a producer-chosen
        // identical base..head yields an empty diff and would vacuously pass.
        // Fail-closed instead.
        if (diffBase === diffHead) {
          return {
            score: 0,
            rationale: `anti-drift-scope: diff_base equals diff_head (${diffBase}); empty range proves nothing (fail-closed)`,
          };
        }

        if (!capturedExec) {
          return {
            score: 0,
            rationale: "anti-drift-scope: no executor wired; cannot run git diff (fail-closed)",
          };
        }

        // ── Execute git diff --name-only ──────────────────────────────────
        // Zero-trust: only validated hex refs and the validated absolute
        // worktree path reach the command string. No shell interpolation.
        const cmd = `git diff --name-only ${diffBase}..${diffHead}`;
        let result: ReturnType<ExecFn>;
        try {
          result = capturedExec(cmd, worktree);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            score: 0,
            rationale: `anti-drift-scope: executor threw (fail-closed): ${msg}`,
          };
        }

        if (result.exitCode !== 0) {
          const detail = (result.stderr || result.stdout).slice(0, 400);
          return {
            score: 0,
            rationale: `anti-drift-scope: git diff exited ${result.exitCode} (fail-closed): ${detail}`,
          };
        }

        // ── Prefix-match every changed file ──────────────────────────────
        const rawFiles = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        const violations: string[] = [];

        for (const rawFile of rawFiles) {
          const file = normaliseGitPath(rawFile);
          if (file === null) {
            // Absolute path or ../ traversal: treat as a violation.
            violations.push(`${rawFile} (rejected: absolute path or ../ traversal)`);
            continue;
          }
          if (!matchesAllowedPrefix(file, allowedPaths)) {
            violations.push(file);
          }
        }

        if (violations.length > 0) {
          return {
            score: 0,
            rationale: `anti-drift-scope: ${violations.length} file(s) outside allowed scope: ${violations.join(", ")}`,
          };
        }

        return {
          score: 1,
          rationale: `anti-drift-scope: all ${rawFiles.length} changed file(s) within allowed scope`,
        };
      },
    },
    polarity: "affirm",
    criticality: "hard",
    signature: { engine: "execution" },
  };
}
