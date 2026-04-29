/**
 * Typed port errors (Sprint-459).
 *
 * Agent handlers can pattern-match on concrete classes to implement
 * intelligent retry, HITL escalation, or graceful degradation:
 *
 *   try {
 *     await deps.brain.archiveKnowledge(entry);
 *   } catch (err) {
 *     if (err instanceof BrainRateLimit) {
 *       await sleep(err.retryAfterMs);
 *       return retry();
 *     }
 *     if (err instanceof BrainUnavailable) {
 *       return { skipped: true, reason: "brain down" };
 *     }
 *     throw err;
 *   }
 *
 * All port-error classes extend `PortError` for a single instanceof check
 * when agents want to distinguish port failures from tool / LLM failures.
 *
 * Errors carry a `cause` field (native Error cause) so the underlying
 * exception remains debuggable; and a `retryable` boolean so orchestrators
 * can apply generic retry policies without class-specific knowledge.
 */

/** Base class for every port-layer error thrown by an SDK-injected port. */
export abstract class PortError extends Error {
  /** Port identifier that raised the error (e.g. "brain", "db"). */
  abstract readonly port: string;
  /** True if the caller MAY retry after some backoff. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
    // Ensure `.cause` is preserved across node versions.
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Brain port errors ────────────────────────────────────────────────────

export class BrainUnavailable extends PortError {
  readonly port = "brain";
  constructor(message = "Brain service unreachable", cause?: unknown) {
    super(message, { cause, retryable: true });
  }
}

export class BrainRateLimit extends PortError {
  readonly port = "brain";
  /** Server-advised wait before retry. Missing if unknown. */
  readonly retryAfterMs?: number;
  constructor(
    opts: { message?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(opts.message ?? "Brain rate limit exceeded", {
      cause: opts.cause,
      retryable: true,
    });
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class BrainValidationError extends PortError {
  readonly port = "brain";
  constructor(message: string, cause?: unknown) {
    super(message, { cause, retryable: false });
  }
}

export class BrainAuthError extends PortError {
  readonly port = "brain";
  constructor(message = "Brain auth rejected", cause?: unknown) {
    super(message, { cause, retryable: false });
  }
}

// ─── Db port errors ───────────────────────────────────────────────────────

export class DbConnectionLost extends PortError {
  readonly port = "db";
  constructor(message = "Database connection lost", cause?: unknown) {
    super(message, { cause, retryable: true });
  }
}

export class DbQueryError extends PortError {
  readonly port = "db";
  /** The SQL fragment that failed (first 200 chars). */
  readonly sqlPreview?: string;
  constructor(opts: { message: string; cause?: unknown; sqlPreview?: string }) {
    super(opts.message, { cause: opts.cause, retryable: false });
    this.sqlPreview = opts.sqlPreview?.slice(0, 200);
  }
}

// ─── Outcome port errors ──────────────────────────────────────────────────

export class OutcomeAttributionFailed extends PortError {
  readonly port = "outcome";
  /** agent_run.id that failed to attribute. */
  readonly runId: string;
  constructor(runId: string, message: string, cause?: unknown) {
    super(message, { cause, retryable: false });
    this.runId = runId;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * True if the error is a PortError produced by the named port.
 * Convenience for narrow error handling without leaking class imports.
 */
export function isPortError(err: unknown, port?: string): err is PortError {
  if (!(err instanceof PortError)) return false;
  if (port !== undefined && err.port !== port) return false;
  return true;
}

/**
 * True if the error is a PortError and the originating port marked it
 * retryable. Returns false for unknown errors — caller should rethrow.
 */
export function isRetryablePortError(err: unknown): err is PortError {
  return err instanceof PortError && err.retryable;
}
