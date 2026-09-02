/**
 * W3C Trace Context propagation utilities for delegation chains.
 *
 * Implements W3C Trace Context Level 1 (traceparent / tracestate) via
 * the @opentelemetry/api propagation and context APIs — no @opentelemetry/core
 * dependency required.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 */

import {
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  type TextMapGetter,
  type TextMapSetter,
  context,
  createTraceState,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  trace,
} from "@opentelemetry/api";

// ─── W3C Trace Context propagator (inline — no @opentelemetry/core dep) ──────

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";

// Format: 00-<32hex traceId>-<16hex spanId>-<2hex flags>
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

class W3CTraceContextPropagatorImpl {
  inject(
    ctx: ReturnType<typeof context.active>,
    carrier: Record<string, string>,
    setter: TextMapSetter<Record<string, string>>,
  ): void {
    const spanContext = trace.getSpanContext(ctx);
    if (!spanContext || !isValidSpanCtx(spanContext)) return;

    const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
    const traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
    setter.set(carrier, TRACEPARENT_HEADER, traceparent);

    if (spanContext.traceState) {
      const ts = spanContext.traceState.serialize();
      if (ts) setter.set(carrier, TRACESTATE_HEADER, ts);
    }
  }

  extract(
    ctx: ReturnType<typeof context.active>,
    carrier: Record<string, string>,
    getter: TextMapGetter<Record<string, string>>,
  ): ReturnType<typeof context.active> {
    const traceparentHeader = getter.get(carrier, TRACEPARENT_HEADER);
    if (!traceparentHeader) return ctx;
    const raw = Array.isArray(traceparentHeader) ? traceparentHeader[0] : traceparentHeader;
    if (!raw) return ctx;

    const match = TRACEPARENT_RE.exec(raw);
    if (!match) return ctx;

    const traceId = match[1].toLowerCase();
    const spanId = match[2].toLowerCase();
    const traceFlags = Number.parseInt(match[3], 16);

    // Reject all-zero ids
    if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return ctx;

    const tracestateHeader = getter.get(carrier, TRACESTATE_HEADER);
    const rawTracestate = Array.isArray(tracestateHeader)
      ? tracestateHeader.join(",")
      : tracestateHeader;

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags,
      traceState: rawTracestate ? createTraceState(rawTracestate) : undefined,
      isRemote: true,
    };

    return trace.setSpanContext(ctx, spanContext);
  }
}

const _propagator = new W3CTraceContextPropagatorImpl();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Registers the W3C Trace Context propagator as the global OTel propagator.
 * Safe to call multiple times — idempotent (re-registers on every call).
 *
 * Called automatically by initVaubanSDK. External callers only need this when
 * using the trace-context utilities without calling initVaubanSDK.
 */
export function registerW3CPropagator(): void {
  propagation.setGlobalPropagator({
    inject(ctx, carrier, setter) {
      _propagator.inject(
        ctx,
        carrier as Record<string, string>,
        setter as TextMapSetter<Record<string, string>>,
      );
    },
    extract(ctx, carrier, getter) {
      return _propagator.extract(
        ctx,
        carrier as Record<string, string>,
        getter as TextMapGetter<Record<string, string>>,
      );
    },
    fields() {
      return [TRACEPARENT_HEADER, TRACESTATE_HEADER];
    },
  });
}

/**
 * Injects W3C traceparent/tracestate headers into a carrier map.
 *
 * Uses the active span context (or the provided OTel Context if given).
 *
 * @param headers - Mutable header map to inject into (safe to start empty).
 * @param ctx     - Optional OTel Context; defaults to context.active().
 * @returns The same map with traceparent/tracestate added (or unchanged if
 *          no active span context is available).
 */
export function injectTraceContext(
  headers: Record<string, string>,
  ctx?: ReturnType<typeof context.active>,
): Record<string, string> {
  const activeCtx = ctx ?? context.active();
  propagation.inject(activeCtx, headers, defaultTextMapSetter);
  return headers;
}

/**
 * Extracts a SpanContext from W3C traceparent/tracestate headers.
 *
 * @param headers - Header map (e.g. incoming HTTP request headers).
 * @returns The extracted SpanContext, or null if no valid traceparent header
 *          is present or the header is malformed.
 */
export function extractTraceContext(headers: Record<string, string>): SpanContext | null {
  const extracted = propagation.extract(ROOT_CONTEXT, headers, defaultTextMapGetter);
  const spanCtx = trace.getSpanContext(extracted);
  if (!spanCtx || !isValidSpanCtx(spanCtx)) return null;
  return spanCtx;
}

/**
 * Sets `gen_ai.delegation.parent_run_id` on the given span.
 *
 * Every span emitted by a child delegation cycle MUST carry this attribute
 * so that trace queries in Tempo / Langfuse can reconstruct delegation trees.
 *
 * @param span        - The OTel Span to annotate (must be recording).
 * @param parentRunId - The runId of the parent agent cycle.
 */
export function withDelegationAttribute(span: Span, parentRunId: string): void {
  span.setAttribute("gen_ai.delegation.parent_run_id", parentRunId);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function isValidSpanCtx(spanCtx: SpanContext): boolean {
  return (
    spanCtx.traceId.length === 32 &&
    spanCtx.spanId.length === 16 &&
    spanCtx.traceId !== "0".repeat(32) &&
    spanCtx.spanId !== "0".repeat(16)
  );
}
