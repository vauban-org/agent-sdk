import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Context,
  type ContextManager,
  ROOT_CONTEXT,
  type SpanContext,
  context,
  trace,
} from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerW3CPropagator } from "../../otel/trace-context.js";
import { type MCPClientLike, tracedMcpClient } from "./mcp.js";

// W3C traceparent: 00-<32hex traceId>-<16hex spanId>-<2hex flags>
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Minimal AsyncLocalStorage-backed context manager so `context.with(ctx, fn)`
 * actually makes `ctx` active for `context.active()` (the default OTel manager
 * is a no-op until a host SDK registers one ; in production `initVaubanSDK`'s
 * host registers an async-hooks manager). This mirrors that for the test.
 */
class AlsContextManager implements ContextManager {
  readonly #als = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#als.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#als.run(ctx, () => fn.apply(thisArg as ThisParameterType<F>, args));
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#als.disable();
    return this;
  }
}

/** Build an OTel context carrying a known, valid remote span context. */
function ctxWith(traceId: string, spanId: string): ReturnType<typeof context.active> {
  const sc: SpanContext = {
    traceId,
    spanId,
    traceFlags: 1,
    isRemote: true,
  };
  return trace.setSpanContext(ROOT_CONTEXT, sc);
}

/** A recording MCPClientLike that captures every (name, args, headers) call. */
class RecordingClient implements MCPClientLike {
  calls: Array<{
    name: string;
    args: unknown;
    headers: Record<string, string> | undefined;
  }> = [];

  async callTool(name: string, args: unknown, headers?: Record<string, string>): Promise<unknown> {
    this.calls.push({ name, args, headers });
    return { ok: true };
  }
}

describe("tracedMcpClient — cross-MCP W3C trace propagation", () => {
  const ctxManager = new AlsContextManager();

  beforeAll(() => {
    registerW3CPropagator();
    context.setGlobalContextManager(ctxManager.enable());
  });

  afterAll(() => {
    context.disable();
  });

  it("injects a well-formed traceparent header from the active span context", async () => {
    const inner = new RecordingClient();
    const traced = tracedMcpClient(inner);

    const traceId = "1234567890abcdef1234567890abcdef";
    const spanId = "abcdef1234567890";

    await context.with(ctxWith(traceId, spanId), async () => {
      await traced.callTool("publish_article", { title: "x" });
    });

    expect(inner.calls).toHaveLength(1);
    const headers = inner.calls[0].headers;
    expect(headers).toBeDefined();
    const tp = headers?.traceparent;
    expect(tp).toBeDefined();
    expect(tp).toMatch(TRACEPARENT_RE);
    // The injected traceparent carries the active trace + span ids.
    expect(tp).toBe(`00-${traceId}-${spanId}-01`);
  });

  it("forwards name and args unchanged to the inner client", async () => {
    const inner = new RecordingClient();
    const traced = tracedMcpClient(inner);

    await context.with(
      ctxWith("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"),
      async () => {
        await traced.callTool("do_thing", { a: 1, b: "two" });
      },
    );

    expect(inner.calls[0].name).toBe("do_thing");
    expect(inner.calls[0].args).toEqual({ a: 1, b: "two" });
  });

  it("merges injected headers with caller-supplied headers (caller not clobbered)", async () => {
    const inner = new RecordingClient();
    const traced = tracedMcpClient(inner);

    await context.with(
      ctxWith("cccccccccccccccccccccccccccccccc", "dddddddddddddddd"),
      async () => {
        await traced.callTool("t", {}, { "x-custom": "kept" });
      },
    );

    const headers = inner.calls[0].headers;
    expect(headers?.["x-custom"]).toBe("kept");
    expect(headers?.traceparent).toBeDefined();
  });

  it("omits traceparent when there is no active span context (no-op carrier)", async () => {
    const inner = new RecordingClient();
    const traced = tracedMcpClient(inner);

    // ROOT_CONTEXT carries no span context => nothing to inject.
    await context.with(ROOT_CONTEXT, async () => {
      await traced.callTool("t", {});
    });

    const headers = inner.calls[0].headers;
    // Either undefined headers or an object without traceparent is acceptable;
    // the contract is "no traceparent when no active span".
    expect(headers?.traceparent).toBeUndefined();
  });
});
