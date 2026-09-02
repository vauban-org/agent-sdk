import { beforeAll, describe, expect, it } from "vitest";
import { extractTraceContext, registerW3CPropagator } from "./trace-context.js";

/**
 * RECEIVE-side mirror of the INJECT-side coverage in
 * adapters/messaging/mcp-trace.test.ts.
 *
 * extractTraceContext is the agent-sdk-owned primitive an MCP server consumes
 * to continue an incoming trace (the per-server context.with wiring lives in
 * the separate MCP server deployments, out of agent-sdk scope).
 */
describe("extractTraceContext (receive-side W3C propagation)", () => {
  const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
  const SPAN_ID = "b7ad6b7169203331";

  // extractTraceContext relies on the global W3C propagator, exactly as
  // injectTraceContext does (registered automatically by initVaubanSDK).
  beforeAll(() => {
    registerW3CPropagator();
  });

  it("extracts a valid SpanContext from a well-formed traceparent header", () => {
    const ctx = extractTraceContext({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.traceId).toBe(TRACE_ID);
    expect(ctx?.spanId).toBe(SPAN_ID);
    expect(ctx?.traceFlags).toBe(0x01);
    // Extracted context originates from a remote process.
    expect(ctx?.isRemote).toBe(true);
  });

  it("returns null when no traceparent header is present", () => {
    expect(extractTraceContext({})).toBeNull();
    expect(extractTraceContext({ "x-other": "value" })).toBeNull();
  });

  it("returns null on a malformed traceparent header", () => {
    expect(extractTraceContext({ traceparent: "not-a-traceparent" })).toBeNull();
    expect(extractTraceContext({ traceparent: `00-${TRACE_ID}` })).toBeNull();
    // wrong version / truncated ids
    expect(extractTraceContext({ traceparent: "00-abc-def-01" })).toBeNull();
  });

  it("returns null on all-zero trace id or span id (invalid per W3C)", () => {
    expect(
      extractTraceContext({
        traceparent: `00-${"0".repeat(32)}-${SPAN_ID}-01`,
      }),
    ).toBeNull();
    expect(
      extractTraceContext({
        traceparent: `00-${TRACE_ID}-${"0".repeat(16)}-01`,
      }),
    ).toBeNull();
  });

  it("preserves tracestate when present alongside a valid traceparent", () => {
    const ctx = extractTraceContext({
      traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
      tracestate: "vendor1=value1,vendor2=value2",
    });
    expect(ctx).not.toBeNull();
    expect(ctx?.traceState?.get("vendor1")).toBe("value1");
    expect(ctx?.traceState?.get("vendor2")).toBe("value2");
  });

  it("round-trips: a header produced by the injected format is extractable", () => {
    // The W3C format injectTraceContext emits is what a server receives.
    const carrier = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-00` };
    const ctx = extractTraceContext(carrier);
    expect(ctx?.traceId).toBe(TRACE_ID);
    expect(ctx?.spanId).toBe(SPAN_ID);
    expect(ctx?.traceFlags).toBe(0x00);
  });
});
