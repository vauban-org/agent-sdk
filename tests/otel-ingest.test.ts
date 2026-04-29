/**
 * createOtelClient — ingestSpans REST client tests.
 *
 * Sprint: command-center:sprint-523:quick-6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOtelClient } from "../src/otel/ingest.js";
import type { OtlpRequest } from "../src/otel/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeOtlpRequest(): OtlpRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "my-agent" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "my-agent-tracer", version: "1.0.0" },
            spans: [
              {
                traceId: "abc123def456abc123def456abc123de",
                spanId: "abc123de456def01",
                name: "llm.completion",
                kind: 3,
                startTimeUnixNano: "1714299600000000000",
                endTimeUnixNano: "1714299601200000000",
                attributes: [
                  { key: "gen_ai.system", value: { stringValue: "openai" } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("createOtelClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs OTLP request to /api/otel/ingest and returns accepted count", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: 1, skipped: 0, runs: ["run-trace-abc"], warnings: [] })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "test-token",
    });

    const result = await client.ingestSpans(makeOtlpRequest());

    expect(result.accepted).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, callOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/otel/ingest");
    expect((callOpts.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-token");
    expect(callOpts.method).toBe("POST");
  });

  it("sends Content-Type: application/json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ accepted: 0, warnings: [] })
    ));

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "tok",
    });

    await client.ingestSpans(makeOtlpRequest());

    const [, callOpts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit];
    expect((callOpts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends X-Origin header when origin option is provided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ accepted: 1 })
    ));

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "tok",
    });

    await client.ingestSpans(makeOtlpRequest(), { origin: "langgraph-flow-1" });

    const [, callOpts] = (vi.mocked(fetch)).mock.calls[0] as [string, RequestInit];
    expect((callOpts.headers as Record<string, string>)["X-Origin"]).toBe("langgraph-flow-1");
  });

  it("throws on non-ok response with error message from body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      jsonResponse({ error: "Rate limit exceeded" }, 429)
    ));

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "tok",
    });

    await expect(client.ingestSpans(makeOtlpRequest())).rejects.toThrow("Rate limit exceeded");
  });

  it("throws with HTTP status on non-ok response without error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response));

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "tok",
    });

    await expect(client.ingestSpans(makeOtlpRequest())).rejects.toThrow("HTTP 503");
  });

  it("serializes OTLP payload as JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: 1 })
    );
    vi.stubGlobal("fetch", mockFetch);

    const client = createOtelClient({
      baseUrl: "http://localhost:8080",
      getToken: async () => "tok",
    });

    const req = makeOtlpRequest();
    await client.ingestSpans(req);

    const [, callOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callOpts.body).toBe(JSON.stringify(req));
  });
});
