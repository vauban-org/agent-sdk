/**
 * LoggerPort — structured logger interface.
 *
 * Shape matches Pino's child-logger subset. Host wires any concrete
 * logger (pino, winston, console-shim) that implements these methods.
 *
 * OTel instrumentation: import { createTracedLoggerPort } to wrap any
 * LoggerPort implementation with OpenTelemetry spans per log call.
 * Gracefully degrades to noop spans when no OTel SDK is installed.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

/** @public */
export interface LoggerPort {
  debug(objOrMsg: object | string, msg?: string): void;
  info(objOrMsg: object | string, msg?: string): void;
  warn(objOrMsg: object | string, msg?: string): void;
  error(objOrMsg: object | string, msg?: string): void;
  child?(bindings: Record<string, unknown>): LoggerPort;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when the log transport fails to flush pending buffers (disk full,
 * network timeout on remote sink, or backend refused connection).
 * Callers may retry flush or discard pending entries depending on criticality.
 * @public
 */
export class LoggerFlushError extends Error {
  /** Number of log entries that could not be flushed. */
  readonly pendingCount: number;

  constructor(
    message: string,
    pendingCount: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LoggerFlushError";
    this.pendingCount = pendingCount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * noopLogger — convenience for tests where logs are not asserted.
 * @public
 */
export const noopLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Wrap any LoggerPort implementation with OTel spans per log call.
 * Each log level emits a short-lived span capturing the level and
 * optional metadata. Gracefully degrades to noop spans when no OTel
 * SDK is installed.
 *
 * Usage:
 *   const raw: LoggerPort = pino();
 *   const traced = createTracedLoggerPort(raw);
 *   traced.info("boot") // emits "logger.info" span
 */
export function createTracedLoggerPort(impl: LoggerPort): LoggerPort {
  function tracedLog(level: string, objOrMsg: object | string, msg?: string): void {
    PORT_TRACER.startActiveSpan(
      `logger.${level}`,
      {
        attributes: {
          "log.level": level,
          "vauban.port.name": "logger",
        },
      },
      (span: Span) => {
        try {
          const fn = (impl as unknown as Record<string, (...args: unknown[]) => void>)[level];
          if (typeof fn !== "function") {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `LoggerPort missing method: ${level}`,
            });
            return;
          }
          if (msg !== undefined) {
            fn(objOrMsg, msg);
          } else {
            fn(objOrMsg);
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          span.end();
        }
      },
    );
  }

  return {
    debug: (objOrMsg: object | string, msg?: string) => tracedLog("debug", objOrMsg, msg),
    info: (objOrMsg: object | string, msg?: string) => tracedLog("info", objOrMsg, msg),
    warn: (objOrMsg: object | string, msg?: string) => tracedLog("warn", objOrMsg, msg),
    error: (objOrMsg: object | string, msg?: string) => tracedLog("error", objOrMsg, msg),
    child: impl.child
      ? // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
        (bindings: Record<string, unknown>) => createTracedLoggerPort(impl.child!(bindings))
      : undefined,
  };
}
