/**
 * tracedPort — instrument any port implementation with OTel spans.
 *
 * Sprint-460 — ships uniform observability for BrainPort / OutcomePort /
 * DbPort / any host-injected async surface. Wraps every function-valued
 * method of the impl in a span rooted at the active context; attributes
 * follow OpenTelemetry Semantic Conventions for GenAI operations where
 * applicable (gen_ai.system, gen_ai.operation.name).
 *
 * Usage:
 *   const raw: BrainPort = buildHttpBrain(...);
 *   const traced = tracedPort(raw, { portName: "brain", tracerName: "vauban-agent-sdk" });
 *   // traced.archiveKnowledge(...) emits a span per call.
 *
 * Transparent: the proxy's type is identical to T. Non-function fields
 * are forwarded unchanged. Sync methods still get a span (they complete
 * within the synchronous call frame).
 *
 * Opt-out: if no tracer is configured (getTracer returns the noop tracer,
 * which is the OTel default when no SDK is installed), spans become
 * no-ops — zero runtime cost for consumers who don't want tracing.
 */

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

export interface TracedPortOptions {
  /**
   * Short port identifier, e.g. "brain", "outcome", "db". Emitted as
   * `gen_ai.system` attribute and used in span names.
   */
  portName: string;
  /**
   * OTel tracer name. Defaults to "vauban-agent-sdk".
   */
  tracerName?: string;
  /**
   * Optional hook to enrich the span with impl-specific attributes
   * before it completes. Receives the span, method name, and the
   * args/return-value of the call.
   */
  attributeHook?: (ctx: {
    span: Span;
    method: string;
    args: readonly unknown[];
    result?: unknown;
  }) => void;
}

/**
 * Wrap a port impl. Returns a proxy with the same type, instrumented.
 */
export function tracedPort<T extends object>(
  impl: T,
  options: TracedPortOptions,
): T {
  const tracer = trace.getTracer(options.tracerName ?? "vauban-agent-sdk");
  const { portName } = options;

  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const methodName = String(prop);

      // Return a wrapper that traces each call. Preserve `this` = impl.
      const wrapped = function (this: unknown, ...args: unknown[]) {
        return tracer.startActiveSpan(
          `${portName}.${methodName}`,
          {
            attributes: {
              "gen_ai.system": portName,
              "gen_ai.operation.name": methodName,
            },
          },
          (span) => {
            try {
              const out = (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );

              // Async path: settle the span on promise resolution.
              if (out instanceof Promise) {
                return out.then(
                  (result) => {
                    options.attributeHook?.({
                      span,
                      method: methodName,
                      args,
                      result,
                    });
                    span.setStatus({ code: SpanStatusCode.OK });
                    span.end();
                    return result;
                  },
                  (err: unknown) => {
                    recordError(span, err);
                    span.end();
                    throw err;
                  },
                );
              }

              // Sync path.
              options.attributeHook?.({
                span,
                method: methodName,
                args,
                result: out,
              });
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return out;
            } catch (err) {
              recordError(span, err);
              span.end();
              throw err;
            }
          },
        );
      };
      // Preserve function name for stack traces + debugging.
      Object.defineProperty(wrapped, "name", { value: methodName });
      return wrapped;
    },
  }) as T;
}

function recordError(span: Span, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "error";
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  if (err instanceof Error) span.recordException(err);
  // Surface PortError metadata when present (port-side observability).
  if (err && typeof err === "object") {
    const anyErr = err as { port?: unknown; retryable?: unknown };
    if (typeof anyErr.port === "string") {
      span.setAttribute("vauban.port.error.port", anyErr.port);
    }
    if (typeof anyErr.retryable === "boolean") {
      span.setAttribute("vauban.port.error.retryable", anyErr.retryable);
    }
  }
}
