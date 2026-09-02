/**
 * Container Execution Protocol — standard contract for running automations
 * inside containers or as local binaries.
 *
 * Contract:
 *
 *   Input (via env vars):
 *     VAUBAN_EXECUTION_ID    — unique execution identifier (UUID)
 *     VAUBAN_AUTOMATION_NAME — automation name (kebab-case)
 *     VAUBAN_INPUT           — JSON-encoded input parameters
 *     VAUBAN_TIMEOUT         — timeout in seconds
 *     VAUBAN_MODE            — execution mode (default: "execute")
 *
 *   Output (via stdout, last non-empty line, JSON):
 *     { "status": "completed", "output": <any> }
 *     { "status": "failed", "error": { "code": "...", "message": "...", "details"?: <any> } }
 *
 *   Diagnostics (via stderr, optional, one JSON object per line):
 *     { "level": "info", "message": "...", "timestamp": "..." }
 *     { "progress": 0.5, "message": "..." }
 *
 * @public @since 1.2.0
 */

/**
 * Reserved environment variable names. All caller env merged on top must NOT
 * shadow these keys, or the automation's view of its own context becomes
 * undefined.
 *
 * @public
 */
export const PROTOCOL_ENV = {
  EXECUTION_ID: "VAUBAN_EXECUTION_ID",
  AUTOMATION_NAME: "VAUBAN_AUTOMATION_NAME",
  INPUT: "VAUBAN_INPUT",
  TIMEOUT: "VAUBAN_TIMEOUT",
  MODE: "VAUBAN_MODE",
} as const;

/**
 * Default protocol mode set when caller does not specify one.
 * @public
 */
export const DEFAULT_PROTOCOL_MODE = "execute";

/**
 * Final status reported by a container/binary on stdout.
 * @public
 */
export type ProtocolStatus = "completed" | "failed";

/**
 * Discriminated union of protocol outputs parsed from stdout.
 * @public
 */
export type ProtocolResult<T = unknown> =
  | { readonly status: "completed"; readonly output: T }
  | {
      readonly status: "failed";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };

/**
 * Outcome of an execution attempt, combining protocol result with timing,
 * captured logs, and propagated metadata.
 *
 * @public
 */
export interface ExecutionResult<T = unknown> {
  readonly executionId: string;
  readonly automationName: string;
  readonly status: "completed" | "failed" | "timeout";
  readonly input: unknown;
  readonly output?: T;
  readonly error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly durationMs: number;
  readonly logs: ReadonlyArray<{
    readonly level: string;
    readonly message: string;
    readonly timestamp: string;
  }>;
}

/**
 * Thrown when stdout does not contain a parseable protocol result on its last
 * non-empty line.
 *
 * @public
 */
export class ProtocolParseError extends Error {
  readonly rawTail: string;
  constructor(reason: string, rawTail: string) {
    super(`container-protocol: ${reason}`);
    this.name = "ProtocolParseError";
    this.rawTail = rawTail;
  }
}

/**
 * Build the protocol's environment variables. Caller `extraEnv` is merged
 * AFTER protocol env, so it cannot accidentally override reserved keys.
 *
 * @public
 */
export function buildProtocolEnv(args: {
  executionId: string;
  automationName: string;
  input: unknown;
  timeoutSeconds: number;
  mode?: string;
  extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (args.extraEnv) {
    for (const [k, v] of Object.entries(args.extraEnv)) {
      env[k] = v;
    }
  }
  env[PROTOCOL_ENV.EXECUTION_ID] = args.executionId;
  env[PROTOCOL_ENV.AUTOMATION_NAME] = args.automationName;
  env[PROTOCOL_ENV.INPUT] = JSON.stringify(args.input);
  env[PROTOCOL_ENV.TIMEOUT] = String(args.timeoutSeconds);
  env[PROTOCOL_ENV.MODE] = args.mode ?? DEFAULT_PROTOCOL_MODE;
  return env;
}

/**
 * Parse the last non-empty line of stdout as a {@link ProtocolResult}.
 *
 * @throws {@link ProtocolParseError} when stdout is empty, has no JSON tail,
 *   or the JSON does not match the protocol shape.
 *
 * @public
 */
export function parseProtocolOutput<T = unknown>(stdout: string): ProtocolResult<T> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new ProtocolParseError("stdout is empty", "");
  }
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine.length === 0) {
    throw new ProtocolParseError("last stdout line is empty", trimmed.slice(-200));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new ProtocolParseError("last stdout line is not valid JSON", lastLine.slice(0, 500));
  }

  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) {
    throw new ProtocolParseError("protocol JSON missing 'status' field", lastLine.slice(0, 500));
  }

  const obj = parsed as Record<string, unknown>;
  const status = obj.status;

  if (status === "completed") {
    return { status: "completed", output: (obj.output ?? null) as T };
  }

  if (status === "failed") {
    const err = (obj.error as Record<string, unknown> | undefined) ?? {};
    const code = typeof err.code === "string" ? (err.code as string) : "UNKNOWN";
    const message = typeof err.message === "string" ? (err.message as string) : "(no message)";
    const details = err.details;
    return { status: "failed", error: { code, message, details } };
  }

  throw new ProtocolParseError(
    `unknown protocol status: ${String(status)}`,
    lastLine.slice(0, 500),
  );
}

/**
 * Parse stderr lines as JSON log entries when possible; fall back to plain
 * text wrapped at level "info". Used by {@link ContainerRuntime} to populate
 * `ExecutionResult.logs`.
 *
 * @public
 */
export function parseStderrLogs(stderr: string): Array<{
  level: string;
  message: string;
  timestamp: string;
}> {
  const logs: Array<{ level: string; message: string; timestamp: string }> = [];
  const lines = stderr.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      logs.push({
        level: typeof obj.level === "string" ? (obj.level as string) : "info",
        message: typeof obj.message === "string" ? (obj.message as string) : line.slice(0, 500),
        timestamp:
          typeof obj.timestamp === "string" ? (obj.timestamp as string) : new Date().toISOString(),
      });
    } catch {
      logs.push({
        level: "info",
        message: line.slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    }
  }
  return logs;
}
