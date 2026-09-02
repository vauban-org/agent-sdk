/**
 * delivery/types.ts
 *
 * The shared contracts of the delivery gate module. Every type here is a pure
 * data or function shape; nothing in this file touches the filesystem, a
 * subprocess, or the network. The two I/O seams the gate needs (running a
 * command, reading a file) are declared here as INJECTED function types
 * ({@link ExecFn}, {@link FileReader}) and implemented outside the pure core in
 * `node-exec.ts`, so a caller can drive the whole gate with deterministic mocks.
 *
 * @module delivery/types
 */

/** An anchor spec as received from `get_current_stage` (data, not code). */
export interface AnchorSpecInput {
  readonly id: string;
  readonly kind: "pure" | "ci";
}

/** A deterministic anchor check over the stage artifact (string content). */
export type AnchorCheck = (artifact: string) => {
  pass: boolean;
  rationale: string;
};

/** Result of really running a command in a worktree. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injectable command executor. Production supplies a real spawnSync-backed
 * implementation (see `node-exec.ts`); tests supply a deterministic mock. Runs
 * `cmd` (a shell string) in `cwd` and returns the true exit code + captured
 * output.
 */
export type ExecFn = (cmd: string, cwd: string) => ExecResult;

/**
 * Injected file reader. Production supplies a real `readFileSync`-backed
 * implementation (see `node-exec.ts`); tests supply a deterministic mock. MUST
 * throw if the file is missing or unreadable (a declared-but-unwritten config
 * file must fail closed).
 */
export type FileReader = (absPath: string) => string;

/**
 * The normalized outcome of really executing the stage's test command. Computed
 * ONCE per gate run and shared by every execution-grounded anchor lens, so the
 * tests run a single time even when 2-3 ci anchors are required.
 */
export interface GroundedTestResult {
  /** True only when the test command actually ran (artifact declared it + exec available). */
  readonly ran: boolean;
  readonly exitCode: number;
  readonly passCount: number;
  readonly failCount: number;
  /**
   * Tests the runner COLLECTED, when its output states it explicitly (node:test
   * `# tests N`, pytest `collected N items`, jest `N total`). ABSENT when no
   * explicit collected marker was found: a count inferred as pass+fail+skip
   * would silently miss tests the runner never collected (a narrowed selection),
   * which is exactly what a monotonicity check exists to detect, so absence is
   * reported rather than reconstructed.
   */
  readonly collectedCount?: number;
  /**
   * Tests the runner SKIPPED (node:test `# skipped N`, `N skipped`). ABSENT when
   * the output states no skip figure at all ; `0` means the runner reported zero
   * skips, which is a different fact.
   */
  readonly skipCount?: number;
  readonly rationale: string;
}

/**
 * A verdict computed OUTSIDE this module by the caller that owns the fact, for an
 * anchor listed in {@link ../delivery/anchor-checks.ENGINE_GROUNDED_ANCHORS}.
 *
 * Some execution-grounded anchors are not answerable from the artifact bytes NOR
 * from a test run: `test-surface-frozen` is a git-diff fact about the run's base
 * commit, and `pass-count-monotone` compares against a baseline only the run's
 * own history holds. The engine that owns those facts computes the verdict and
 * injects it here, so the lens reports a measured outcome instead of reading a
 * self-declared boolean out of the artifact (the v1 `ci_passed` hole).
 *
 * A required engine-grounded anchor with NO injected verdict fails closed.
 */
export interface EngineVerdict {
  readonly pass: boolean;
  readonly rationale: string;
}

/** Outcome of really reading + parsing the declared config files from disk. */
export interface ConfigValidationResult {
  /** True only when worktree + files_changed are present AND a reader was supplied (it actually attempted). */
  readonly ran: boolean;
  /** True only when every declared file was read and parsed/validated successfully. */
  readonly valid: boolean;
  /** On failure: the offending filename + the parse/validation error. */
  readonly rationale: string;
}
