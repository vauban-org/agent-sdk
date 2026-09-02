/**
 * ContainerRuntime — execute automations as local binaries or as containers,
 * speaking the {@link ./protocol.ts | Container Execution Protocol}.
 *
 * Two modes:
 *
 *   - **Binary**: spawn a local executable directly (Rust/Go/Python binary).
 *     The runtime uses `node:child_process.spawn` by default; tests inject a
 *     `SpawnFn` to avoid actually running anything.
 *
 *   - **Container**: delegate to a host-provided {@link SandboxExecutor}.
 *     This is structurally compatible with Command Center's `DockerExecutor`
 *     (hardened isolation), so the SDK stays decoupled from any specific
 *     sandbox implementation.
 *
 * @public @since 1.2.0
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  type ExecutionResult,
  ProtocolParseError,
  buildProtocolEnv,
  parseProtocolOutput,
  parseStderrLogs,
} from "./protocol.js";

/**
 * Description of a sandboxed job — structurally identical to Command Center's
 * `SandboxJob`. Defined here so the SDK has no dependency on a specific
 * sandbox implementation.
 *
 * @public
 */
export interface SandboxJob {
  image: string;
  command: string[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  networkMode?: "none" | "outbound" | "bridge";
  readOnlyRoot?: boolean;
  memoryMb?: number;
  cpuQuota?: number;
}

/**
 * Outcome of a sandbox run — structurally identical to Command Center's
 * `SandboxResult`.
 *
 * @public
 */
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Port for a process sandbox (Docker, Firecracker, etc.). The host injects an
 * implementation at runtime; the SDK never depends on a concrete sandbox.
 *
 * @public
 */
export interface SandboxExecutor {
  run(job: SandboxJob): Promise<SandboxResult>;
}

/**
 * Spawn function signature, mirrors `node:child_process.spawn`. Injectable so
 * tests can avoid spawning real subprocesses.
 *
 * @public
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    stdio: ["pipe", "pipe", "pipe"];
    signal?: AbortSignal;
  },
) => ChildProcess;

/**
 * Options for {@link ContainerRuntime.executeContainer}.
 *
 * @public
 */
export interface ContainerExecutionOptions {
  executionId?: string;
  timeoutSeconds?: number;
  extraEnv?: Record<string, string>;
  mode?: string;
  networkMode?: "none" | "outbound" | "bridge";
  readOnlyRoot?: boolean;
  memoryMb?: number;
  cpuQuota?: number;
}

/**
 * Options for {@link ContainerRuntime.executeBinary}.
 *
 * @public
 */
export interface BinaryExecutionOptions {
  executionId?: string;
  timeoutSeconds?: number;
  extraEnv?: Record<string, string>;
  cwd?: string;
  mode?: string;
}

/**
 * Construct a {@link ContainerRuntime} bound to a {@link SandboxExecutor}
 * (for container mode) and optionally a custom `SpawnFn` (for binary
 * mode tests).
 *
 * @public
 */
export interface ContainerRuntimeOptions {
  /** Sandbox executor for container mode. Required if executeContainer() is called. */
  sandbox?: SandboxExecutor;
  /** Spawn function for binary mode. Defaults to node:child_process.spawn. */
  spawnFn?: SpawnFn;
  /** Default timeout when callers don't specify one. */
  defaultTimeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const TRUNCATION_MARKER = "\n[TRUNCATED — output exceeded 1 MB]";

/**
 * Run automations via either a sandboxed container (host-injected) or a local
 * binary subprocess. Both paths produce a uniform {@link ExecutionResult}.
 *
 * @public
 */
export class ContainerRuntime {
  private readonly sandbox: SandboxExecutor | undefined;
  private readonly spawnFn: SpawnFn;
  private readonly defaultTimeoutSeconds: number;

  constructor(opts: ContainerRuntimeOptions = {}) {
    this.sandbox = opts.sandbox;
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    this.defaultTimeoutSeconds = opts.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * Execute an automation packaged as a container image. Delegates to the
   * injected {@link SandboxExecutor} so isolation policy (caps, network,
   * read-only FS) lives in the host implementation.
   */
  async executeContainer<T = unknown>(
    image: string,
    automationName: string,
    input: unknown,
    options: ContainerExecutionOptions = {},
  ): Promise<ExecutionResult<T>> {
    if (!this.sandbox) {
      throw new Error("ContainerRuntime.executeContainer: no SandboxExecutor injected");
    }
    const executionId = options.executionId ?? randomUUID();
    const timeoutSeconds = options.timeoutSeconds ?? this.defaultTimeoutSeconds;
    const startedAt = new Date();

    const env = buildProtocolEnv({
      executionId,
      automationName,
      input,
      timeoutSeconds,
      mode: options.mode,
      extraEnv: options.extraEnv,
    });

    const job: SandboxJob = {
      image,
      command: [],
      env,
      timeoutMs: timeoutSeconds * 1000,
      networkMode: options.networkMode ?? "none",
      readOnlyRoot: options.readOnlyRoot ?? true,
      memoryMb: options.memoryMb ?? 256,
      cpuQuota: options.cpuQuota ?? 0.5,
    };

    const result = await this.sandbox.run(job);
    return this.toExecutionResult<T>({
      executionId,
      automationName,
      input,
      startedAt,
      sandboxResult: result,
    });
  }

  /**
   * Execute an automation packaged as a local binary (Rust release, Python
   * wrapper, shell script). No container — just a hardened subprocess.
   */
  async executeBinary<T = unknown>(
    command: string[],
    automationName: string,
    input: unknown,
    options: BinaryExecutionOptions = {},
  ): Promise<ExecutionResult<T>> {
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error("ContainerRuntime.executeBinary: command must be a non-empty array");
    }
    const executionId = options.executionId ?? randomUUID();
    const timeoutSeconds = options.timeoutSeconds ?? this.defaultTimeoutSeconds;
    const startedAt = new Date();

    const protocolEnv = buildProtocolEnv({
      executionId,
      automationName,
      input,
      timeoutSeconds,
      mode: options.mode,
      extraEnv: options.extraEnv,
    });
    const env: NodeJS.ProcessEnv = { ...process.env, ...protocolEnv };

    const result = await this.runSubprocess({
      cmd: command[0],
      args: command.slice(1),
      env,
      cwd: options.cwd,
      timeoutMs: timeoutSeconds * 1000,
    });

    return this.toExecutionResult<T>({
      executionId,
      automationName,
      input,
      startedAt,
      sandboxResult: result,
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async runSubprocess(args: {
    cmd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string | undefined;
    timeoutMs: number;
  }): Promise<SandboxResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), args.timeoutMs);

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;

    const spawnOpts: {
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      stdio: ["pipe", "pipe", "pipe"];
      signal?: AbortSignal;
    } = {
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: abortController.signal,
    };
    if (args.cwd !== undefined) spawnOpts.cwd = args.cwd;

    const child = this.spawnFn(args.cmd, args.args, spawnOpts);

    if (child.stdin) child.stdin.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(stdoutBuf, "utf8");
      if (remaining <= 0) return;
      const piece = chunk.toString("utf8");
      if (Buffer.byteLength(piece, "utf8") <= remaining) {
        stdoutBuf += piece;
      } else {
        stdoutBuf += piece.slice(0, remaining) + TRUNCATION_MARKER;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(stderrBuf, "utf8");
      if (remaining <= 0) return;
      const piece = chunk.toString("utf8");
      if (Buffer.byteLength(piece, "utf8") <= remaining) {
        stderrBuf += piece;
      } else {
        stderrBuf += piece.slice(0, remaining) + TRUNCATION_MARKER;
      }
    });

    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.name === "AbortError" || abortController.signal.aborted) {
          timedOut = true;
          resolve(137);
        } else {
          resolve(1);
        }
      });
    });

    clearTimeout(timeoutHandle);

    return {
      exitCode,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  }

  private toExecutionResult<T>(args: {
    executionId: string;
    automationName: string;
    input: unknown;
    startedAt: Date;
    sandboxResult: SandboxResult;
  }): ExecutionResult<T> {
    const completedAt = new Date(args.startedAt.getTime() + args.sandboxResult.durationMs);
    const logs = parseStderrLogs(args.sandboxResult.stderr);

    if (args.sandboxResult.timedOut) {
      return {
        executionId: args.executionId,
        automationName: args.automationName,
        status: "timeout",
        input: args.input,
        error: {
          code: "TIMEOUT",
          message: `execution timed out after ${args.sandboxResult.durationMs}ms`,
        },
        startedAt: args.startedAt,
        completedAt,
        durationMs: args.sandboxResult.durationMs,
        logs,
      };
    }

    // Try to parse the protocol result FIRST — a non-zero exit with a valid
    // protocol "failed" payload is a business failure, not a container crash.
    try {
      const protocol = parseProtocolOutput<T>(args.sandboxResult.stdout);
      if (protocol.status === "completed") {
        return {
          executionId: args.executionId,
          automationName: args.automationName,
          status: "completed",
          input: args.input,
          output: protocol.output,
          startedAt: args.startedAt,
          completedAt,
          durationMs: args.sandboxResult.durationMs,
          logs,
        };
      }
      return {
        executionId: args.executionId,
        automationName: args.automationName,
        status: "failed",
        input: args.input,
        error: { ...protocol.error },
        startedAt: args.startedAt,
        completedAt,
        durationMs: args.sandboxResult.durationMs,
        logs,
      };
    } catch (err) {
      // No parseable protocol output. If the process exited non-zero, surface
      // it as a container crash; otherwise the binary returned 0 but said
      // nothing useful — also a protocol violation.
      const code = args.sandboxResult.exitCode === 0 ? "INVALID_OUTPUT" : "CONTAINER_EXIT_ERROR";
      const message =
        args.sandboxResult.exitCode === 0
          ? "process exited 0 but produced no protocol result"
          : `process exited with code ${args.sandboxResult.exitCode}`;
      const stderrTail = args.sandboxResult.stderr.slice(-2000);
      const stdoutTail = args.sandboxResult.stdout.slice(-2000);
      const rawTail = err instanceof ProtocolParseError ? err.rawTail : "";
      return {
        executionId: args.executionId,
        automationName: args.automationName,
        status: "failed",
        input: args.input,
        error: {
          code,
          message,
          details: { stderr: stderrTail, stdout: stdoutTail, rawTail },
        },
        startedAt: args.startedAt,
        completedAt,
        durationMs: args.sandboxResult.durationMs,
        logs,
      };
    }
  }
}
