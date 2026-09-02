/**
 * delivery/node-exec.ts
 *
 * The node I/O boundary of the delivery gate module, and the ONLY file in it
 * that imports `node:child_process` / `node:fs`. Everything else in
 * `src/delivery/` is pure or takes its I/O as an injected {@link ExecFn} /
 * {@link FileReader}, which is what lets the whole gate run against
 * deterministic mocks in a test.
 *
 * It carries the zero-trust command boundary ({@link validateTestCommand}): the
 * stage artifact is written by an UNTRUSTED producer, so the command it declares
 * is validated against a security allowlist before any process is spawned. That
 * allowlist has exactly one home ; duplicating it would guarantee divergence
 * between the copies, and a divergent security allowlist is a hole.
 *
 * @module delivery/node-exec
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExecFn, ExecResult, FileReader } from "./types.js";

/** Pure test runners: their args select tests, they do not exec an arbitrary file. */
const PURE_TEST_RUNNERS: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "scarb",
  "snforge",
]);

/** Package managers: must invoke the "test" script, never dlx/exec/run-arbitrary. */
const PKG_MANAGERS: ReadonlySet<string> = new Set(["pnpm", "npm", "yarn"]);

/** Runners whose first non-flag token (the subcommand) must be a test subcommand. */
const SUBCOMMAND_RUNNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  cargo: new Set(["test", "nextest"]),
  go: new Set(["test"]),
};

/**
 * Flags that make an otherwise-allowed runner execute arbitrary code (node -e,
 * node --require, etc.), rejected on ANY token. Bare interpreters (node, python,
 * npx) are excluded from the allowlist entirely because `node file.js` needs no
 * flag at all; only true test runners and package-manager `test` scripts remain.
 */
const DANGEROUS_FLAGS: ReadonlySet<string> = new Set([
  "-r",
  "--require",
  "--import",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--eval-file",
]);

/**
 * Subcommands that fetch + run arbitrary packages, rejected in SUBCOMMAND
 * POSITION (see `subcommandPosition`). Scanning every token instead would
 * confuse a flag's value with a verb: `pnpm test --filter x` is a filter named
 * `x`, not `pnpm x`, and rejecting it denies an honest command.
 */
const DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "dlx",
  "exec",
  "x",
  "run-script",
  "create",
]);

/**
 * Static checkers whose EXIT CODE is a real oracle (typecheck, lint, build) and
 * which READ the project rather than execute it. Value = the subcommands allowed
 * in subcommand position; an EMPTY set means the bin takes no subcommand, so any
 * positional is rejected.
 *
 * `tsc` ; the TypeScript compiler CLI runs no project code. `tsconfig.json` (and
 * whatever it `extends`) is JSON, and `compilerOptions.plugins` are LANGUAGE
 * SERVICE plugins loaded by an editor's tsserver, never by this CLI; custom
 * transformers need a different binary (ts-patch / ttypescript) that is not on
 * this allowlist. The empty subcommand set is deliberate: `tsc file.ts` IGNORES
 * tsconfig.json and checks that file under default, non-strict options, so
 * refusing positionals forces `tsc` to answer against the project config, which
 * is the frozen oracle.
 *
 * `biome` ; a self-contained Rust binary with no JavaScript config and no JS
 * plugin loading. That property is exactly why biome is allowable and `eslint`
 * is NOT: `eslint.config.js` IS JavaScript executed at load and its plugins are
 * arbitrary JS modules, so allowing eslint would be allowing arbitrary code by
 * design. Biome v2 GritQL plugins are a declarative matching DSL with no I/O and
 * no process spawning.
 */
const PROJECT_CHECKERS: Readonly<Record<string, ReadonlySet<string>>> = {
  tsc: new Set(),
  biome: new Set(["check", "lint", "ci"]),
};

/**
 * Per-checker flags that MOVE the oracle instead of reading it.
 *
 * `tsc` ; `--project` / `--build` point the compiler at a different tsconfig,
 * potentially outside the worktree, and `--watch` never terminates so it would
 * burn the exec timeout instead of answering. (`-p` is already refused globally
 * by {@link DANGEROUS_FLAGS} as node's `--print`; it is listed here too so this
 * rule stays complete on its own.)
 *
 * `biome` ; `--write` / `--fix` / `--unsafe` REPAIR the sources and then report
 * success. A checker that fixes what it measures manufactures its own green and
 * is not an oracle at all, so those are refused even though they are harmless
 * for code execution. `--config-path` swaps biome.json for another config.
 */
const CHECKER_ORACLE_FLAGS: Readonly<Record<string, RegExp>> = {
  tsc: /^(--project|-p|--build|-b|--watch|-w)$/,
  biome: /^(--write|--fix|--unsafe|--config-path)$/,
};

/** make flags that escape the worktree (run a Makefile elsewhere). */
const MAKE_ESCAPE_FLAG = /^(-C|--directory|-f|--file|--makefile)$/;

/** Shell metacharacters that would enable chaining, redirection, or substitution. */
const SHELL_METACHARS = /[;&|<>$`(){}\n\r"'\\]/;

/** A validated, ready-to-spawn test command (no shell). */
export interface ParsedTestCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * The flag NAME carried by a token: `--project=other` -> `--project`. Every flag
 * check runs on this rather than on the raw token, because a set or regex that
 * only lists the space-separated form lets the joined form straight through
 * (`--eval=payload` and `make --file=/tmp/Makefile` both used to pass).
 * Non-flag tokens are returned untouched: a path may legitimately contain `=`.
 */
function flagName(token: string): string {
  if (!token.startsWith("-")) {
    return token;
  }
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * The SUBCOMMAND POSITION: the first token that is not a flag. This is the only
 * position where a token means "the verb this binary should run"; anywhere else a
 * token is a flag, a flag's VALUE, or a path.
 *
 * The parser cannot know which flags take a separate value (`--filter x`), so a
 * value sitting before the verb is read as the subcommand and refused by the
 * per-bin rules below. That is deliberate and conservative: the compliant form
 * puts the verb first (`pnpm test --filter x`), which is the shape producers are
 * told to emit, and guessing which flags consume the next token would be a way
 * to smuggle a verb past this check.
 */
function subcommandPosition(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/**
 * Reject a positional that leaves the worktree. Only applied to
 * `PROJECT_CHECKERS`: a checker pointed at another tree returns a green
 * exit code that says nothing about the code under gate, which is a silent
 * no-op pass rather than an oracle.
 */
function assertContainedPaths(bin: string, args: readonly string[]): void {
  for (const t of args) {
    if (t.startsWith("-")) {
      continue;
    }
    if (isAbsolute(t) || t.split("/").includes("..")) {
      throw new Error(`${bin} path '${t}' escapes the worktree (rejected)`);
    }
  }
}

/**
 * Zero-trust validation of a producer-declared test command. The stage artifact
 * is written by an UNTRUSTED producer (an LLM subprocess), so `cmd` and `cwd` are
 * validated before any process is spawned. Layers: (1) `cwd` is an absolute,
 * existing directory; (2) no shell metacharacter (no chaining, redirection, or
 * substitution); (3) no code-exec flag (node -e, --require, ...) on any token,
 * and no arbitrary-package verb (dlx, exec) in `subcommandPosition`; (4)
 * the binary is a pure test runner, OR a package manager invoking the literal
 * `test` script, OR a subcommand runner (cargo/go) on a test subcommand, OR a
 * static checker (`PROJECT_CHECKERS`: tsc/biome) with no oracle-moving flag
 * and no path leaving the worktree, OR make without an escape flag. Bare
 * interpreters (node, python, npx) are NOT allowed because they exec arbitrary
 * files with no flag. Any violation throws; runGroundedTests turns the throw into
 * a fail-closed deny. The command then runs with shell:false.
 *
 * FLAG vs VERB. A code-exec flag is dangerous wherever it sits, so that scan runs
 * on every token. A verb is only a verb in subcommand position, so the
 * arbitrary-package scan runs there alone: `pnpm test --filter x` selects a
 * package named `x`, it does not invoke `pnpm x`, and scanning every token
 * refused that honest command. Both scans compare `flagName`, so the joined
 * form (`--eval=payload`) cannot slip past a check written for the split one.
 *
 * WHY A TYPECHECKER IS A TEST RUNNER HERE. `ci-green` on a TypeScript repo is
 * close to meaningless without a typecheck and a build: the suite can be green
 * while the package does not compile. tsc and biome earn their place because
 * they READ the project instead of executing it (see `PROJECT_CHECKERS`);
 * eslint does not, and is refused.
 *
 * Constraint (documented so producers comply): a package-manager command must put
 * `test` first (`pnpm test --filter x`, not `pnpm --filter x test`), and quoted
 * multi-word args are rejected (no `"` `'`).
 *
 * IRREDUCIBLE RESIDUAL: running a producer's own tests runs producer code by
 * definition (a malicious conftest.py, build.rs, or package.json `test` script).
 * Closing that requires sandboxing the whole verifier (container, read-only FS,
 * no network); tracked as factory-hardening item H-1, out of scope for the
 * command-string boundary this function provides.
 */
export function validateTestCommand(cmd: string, cwd: string): ParsedTestCommand {
  if (!isAbsolute(cwd)) {
    throw new Error(`worktree must be an absolute path (got '${cwd}')`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(cwd);
  } catch {
    throw new Error(`worktree does not exist: '${cwd}'`);
  }
  if (!st.isDirectory()) {
    throw new Error(`worktree is not a directory: '${cwd}'`);
  }
  if (SHELL_METACHARS.test(cmd)) {
    throw new Error(
      "test_cmd contains shell metacharacters (rejected: no chaining, redirection, or substitution allowed)",
    );
  }
  const tokens = cmd.trim().split(/\s+/);
  const bin = tokens[0] ?? "";
  const cmdArgs = tokens.slice(1);
  // A code-exec flag is dangerous wherever it appears, so this scan stays on
  // every token ; a verb is only a verb in subcommand position, so that scan
  // does not.
  for (const t of cmdArgs) {
    const flag = flagName(t);
    if (DANGEROUS_FLAGS.has(flag)) {
      throw new Error(`test_cmd flag '${flag}' can execute arbitrary code (rejected)`);
    }
  }
  const subcommand = subcommandPosition(cmdArgs);
  if (subcommand !== undefined && DANGEROUS_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`test_cmd subcommand '${subcommand}' runs arbitrary packages (rejected)`);
  }
  if (PURE_TEST_RUNNERS.has(bin)) {
    return { bin, args: cmdArgs };
  }
  // `node --test` is the Node built-in test runner ; the producer's documented
  // default test_cmd for a self-contained greenfield module (no package.json /
  // test script, so `pnpm test` is not available). Allow `node` ONLY in --test
  // mode. The DANGEROUS_FLAGS guard above already rejects -e/--eval/--require/
  // --import, so node cannot be coerced into arbitrary-code execution here ; a
  // bare `node file.js` (no --test) stays rejected. Running the producer's test
  // files is the same irreducible producer-code residual (H-1) as vitest/pytest.
  if (bin === "node" && cmdArgs.includes("--test")) {
    return { bin, args: cmdArgs };
  }
  if (PKG_MANAGERS.has(bin)) {
    if (subcommand !== "test") {
      throw new Error(
        `package-manager test_cmd must invoke the 'test' script first (got '${subcommand ?? "<none>"}')`,
      );
    }
    return { bin, args: cmdArgs };
  }
  const subRunner = SUBCOMMAND_RUNNERS[bin];
  if (subRunner) {
    const sub = subcommand ?? "";
    if (!subRunner.has(sub)) {
      throw new Error(`${bin} test_cmd subcommand '${sub}' is not an allowed test subcommand`);
    }
    return { bin, args: cmdArgs };
  }
  const checkerSubcommands = PROJECT_CHECKERS[bin];
  if (checkerSubcommands) {
    const oracleFlag = CHECKER_ORACLE_FLAGS[bin];
    for (const t of cmdArgs) {
      const flag = flagName(t);
      if (oracleFlag?.test(flag)) {
        throw new Error(`${bin} flag '${flag}' moves the oracle instead of reading it (rejected)`);
      }
    }
    if (checkerSubcommands.size === 0) {
      if (subcommand !== undefined) {
        throw new Error(
          `${bin} test_cmd takes no positional argument (got '${subcommand}') ; it must answer against the project config`,
        );
      }
    } else if (subcommand === undefined || !checkerSubcommands.has(subcommand)) {
      throw new Error(
        `${bin} test_cmd subcommand '${subcommand ?? "<none>"}' is not an allowed checker subcommand`,
      );
    }
    assertContainedPaths(bin, cmdArgs);
    return { bin, args: cmdArgs };
  }
  if (bin === "make") {
    for (const t of cmdArgs) {
      const flag = flagName(t);
      if (MAKE_ESCAPE_FLAG.test(flag)) {
        throw new Error(`make flag '${flag}' can escape the worktree (rejected)`);
      }
    }
    return { bin, args: cmdArgs };
  }
  throw new Error(`test_cmd binary '${bin}' is not in the allowed test-runner set`);
}

/**
 * Real command executor for execution-grounded anchors. Validates the
 * producer-declared command (validateTestCommand: the zero-trust boundary) then
 * runs it with NO shell (shell:false), bounded by a timeout so a hung test cannot
 * wedge the gate. This is the verifier independently RUNNING the producer's
 * declared tests; the basis for a non-self-attested ci-green.
 */
export function buildRealExec(): ExecFn {
  return (cmd: string, cwd: string): ExecResult => {
    const { bin, args } = validateTestCommand(cmd, cwd);
    const r = spawnSync(bin, [...args], {
      cwd,
      shell: false,
      encoding: "utf-8",
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      exitCode: r.status ?? (r.error ? 127 : 1),
      stdout: r.stdout ?? "",
      stderr: (r.stderr ?? "") + (r.error ? `\n${r.error.message}` : ""),
    };
  };
}

/**
 * Command executor dedicated to git operations (the B3 commit binding and the
 * drift-scope lens). Unlike buildRealExec, this does NOT route through
 * validateTestCommand (which only allows test runners). The callers already
 * validate hex refs and the absolute worktree path before calling exec; this
 * executor simply spawns the pre-validated git command with shell:false and a
 * short timeout.
 *
 * Tokens (split from the command string) are the only surface passed to
 * spawnSync; no shell expansion occurs.
 */
export function buildGitExec(): ExecFn {
  return (cmd: string, cwd: string): ExecResult => {
    const tokens = cmd.trim().split(/\s+/);
    const bin = tokens[0] ?? "git";
    const args = tokens.slice(1);
    const r = spawnSync(bin, args, {
      cwd,
      shell: false,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      exitCode: r.status ?? (r.error ? 127 : 1),
      stdout: r.stdout ?? "",
      stderr: (r.stderr ?? "") + (r.error ? `\n${r.error.message}` : ""),
    };
  };
}

/**
 * Real file reader for the content-grounded `config-valid` anchor. Reads the
 * declared config file as UTF-8. Throws (propagated by runConfigValidation into
 * a fail-closed result) when the file is missing or unreadable. The worktree
 * path-containment guard runs INSIDE runConfigValidation before this is called,
 * so this reader only ever sees an absolute path already proven to be inside the
 * worktree.
 */
export function buildFileReader(): FileReader {
  return (absPath: string): string => readFileSync(absPath, "utf-8");
}
