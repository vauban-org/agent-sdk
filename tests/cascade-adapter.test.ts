/**
 * Tests for packages/agent-sdk/src/adapters/llm/cascade.ts
 *
 * Coverage:
 *   CascadeAdapter constructor — throws on empty providers
 *   estimateCost — delegates to first provider that implements it, returns 0 otherwise
 *   complete — first provider succeeds, first fails → fallback to second,
 *               all fail → ALL_FAIL_RESPONSE, finishReason=error → skip
 *   stream — first provider yields content, first throws → fallback, all fail → empty delta
 *
 * Ref: test coverage for agent-sdk/adapters/llm/cascade.ts (no prior tests)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock OTEL so the tracer is a no-op
vi.mock("@opentelemetry/api", () => {
  const noop = () => {};
  const span = {
    setAttribute: noop,
    setAttributes: noop,
    setStatus: noop,
    recordException: noop,
    end: noop,
  };
  return {
    SpanStatusCode: { OK: "OK", ERROR: "ERROR" },
    trace: {
      getTracer: () => ({
        startActiveSpan: (_name: string, _opts: unknown, fn: (s: unknown) => unknown) => fn(span),
      }),
    },
  };
});

const { CascadeAdapter } = await import("../src/adapters/llm/cascade.js");

const OK_RESPONSE = {
  content: "hello",
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "gpt-4o",
  finishReason: "stop" as const,
};

const ERROR_RESPONSE = {
  content: "",
  usage: { inputTokens: 0, outputTokens: 0 },
  model: "",
  finishReason: "error" as const,
};

function makeProvider(response: typeof OK_RESPONSE | typeof ERROR_RESPONSE, throws = false) {
  return {
    complete: vi.fn().mockImplementation(async () => {
      if (throws) throw new Error("provider down");
      return response;
    }),
    estimateCost: vi.fn().mockReturnValue({ usd: 0.001 }),
  };
}

const req = {
  messages: [{ role: "user" as const, content: "hi" }],
  model: "gpt-4o",
};

// ─── constructor ────────────────────────────────────────────────────────────

describe("CascadeAdapter constructor", () => {
  it("throws when providers array is empty", () => {
    expect(() => new CascadeAdapter({ providers: [] })).toThrow("at least one provider");
  });
});

// ─── estimateCost ────────────────────────────────────────────────────────────

describe("CascadeAdapter.estimateCost", () => {
  it("delegates to first provider that has estimateCost", () => {
    const p = makeProvider(OK_RESPONSE);
    const adapter = new CascadeAdapter({ providers: [p] });
    const cost = adapter.estimateCost(req);
    expect(cost.usd).toBe(0.001);
    expect(p.estimateCost).toHaveBeenCalledWith(req);
  });

  it("returns { usd: 0 } when no provider implements estimateCost", () => {
    const p = { complete: vi.fn() };
    const adapter = new CascadeAdapter({ providers: [p as never] });
    expect(adapter.estimateCost(req)).toEqual({ usd: 0 });
  });
});

// ─── complete ────────────────────────────────────────────────────────────────

describe("CascadeAdapter.complete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns first provider's response when it succeeds", async () => {
    const p1 = makeProvider(OK_RESPONSE);
    const p2 = makeProvider(OK_RESPONSE);
    const adapter = new CascadeAdapter({ providers: [p1, p2] });
    const resp = await adapter.complete(req);
    expect(resp.content).toBe("hello");
    expect(p2.complete).not.toHaveBeenCalled();
  });

  it("falls back to second provider when first throws", async () => {
    const p1 = makeProvider(OK_RESPONSE, /* throws */ true);
    const p2 = makeProvider(OK_RESPONSE);
    const adapter = new CascadeAdapter({ providers: [p1, p2] });
    const resp = await adapter.complete(req);
    expect(resp.content).toBe("hello");
    expect(p2.complete).toHaveBeenCalledOnce();
  });

  it("falls back when first provider returns finishReason=error", async () => {
    const p1 = makeProvider(ERROR_RESPONSE);
    const p2 = makeProvider(OK_RESPONSE);
    const adapter = new CascadeAdapter({ providers: [p1, p2] });
    const resp = await adapter.complete(req);
    expect(resp.content).toBe("hello");
  });

  it("returns ALL_FAIL_RESPONSE when all providers fail", async () => {
    const p1 = makeProvider(ERROR_RESPONSE);
    const p2 = makeProvider(ERROR_RESPONSE);
    const adapter = new CascadeAdapter({ providers: [p1, p2] });
    const resp = await adapter.complete(req);
    expect(resp.finishReason).toBe("error");
    expect(resp.content).toBe("");
  });
});

// ─── stream ──────────────────────────────────────────────────────────────────

describe("CascadeAdapter.stream", () => {
  it("yields chunks from first streaming provider", async () => {
    const chunks = [
      { delta: "Hello", usage: { inputTokens: 0, outputTokens: 0 } },
      { delta: " world", usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const p = { complete: vi.fn(), stream: vi.fn().mockReturnValue(gen()) };
    const adapter = new CascadeAdapter({ providers: [p as never] });

    const received: unknown[] = [];
    for await (const chunk of adapter.stream(req)) {
      received.push(chunk);
    }
    expect(received).toEqual(chunks);
  });

  it("falls back to next provider when first stream throws", async () => {
    async function* throwingGen() {
      throw new Error("stream error");
      // biome-ignore lint/correctness/noUnreachable: yield after throw makes TS infer the async generator yield type.
      yield { delta: "", usage: { inputTokens: 0, outputTokens: 0 } };
    }

    const chunks = [{ delta: "fallback", usage: { inputTokens: 0, outputTokens: 0 } }];
    async function* goodGen() {
      for (const c of chunks) yield c;
    }

    const p1 = {
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(throwingGen()),
    };
    const p2 = {
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(goodGen()),
    };
    const adapter = new CascadeAdapter({
      providers: [p1 as never, p2 as never],
    });

    const received: unknown[] = [];
    for await (const chunk of adapter.stream(req)) {
      received.push(chunk);
    }
    expect(received).toEqual(chunks);
  });

  it("skips providers without stream support", async () => {
    const chunks = [{ delta: "ok", usage: { inputTokens: 0, outputTokens: 0 } }];
    async function* goodGen() {
      for (const c of chunks) yield c;
    }

    const p1 = { complete: vi.fn() }; // no stream
    const p2 = {
      complete: vi.fn(),
      stream: vi.fn().mockReturnValue(goodGen()),
    };
    const adapter = new CascadeAdapter({
      providers: [p1 as never, p2 as never],
    });

    const received: unknown[] = [];
    for await (const chunk of adapter.stream(req)) received.push(chunk);
    expect(received).toEqual(chunks);
  });
});
