/**
 * Tests for createHttpBrainAdapter — working (WM) / episodic (EM) / claims
 * plane wiring against the deployed Brain V12 REST surface.
 *
 * Ref: command-center:sprint-895:adapter-wm-em-claims
 *
 * No local Brain instance is reachable in this environment (verified: nothing
 * listens on :4000) — all tests mock `fetch` at the HTTP boundary per the
 * task's documented fallback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrainPortFromEnv, createHttpBrainAdapter } from "../src/adapters/brain-http.js";
import { BrainUnavailableError, MemoryValidationError } from "../src/ports/brain.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeAdapter(withAgentId = true) {
  return createHttpBrainAdapter({
    baseUrl: "https://brain.api.vauban.tech",
    brainId: "brain-test-uuid",
    apiKey: "test-api-key",
    ...(withAgentId ? { agentId: "agent-007" } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Feature detection ────────────────────────────────────────────────────────

describe("plane feature detection", () => {
  it("wires `working` only when agentId is supplied", () => {
    expect(makeAdapter(true).working).toBeDefined();
    expect(makeAdapter(false).working).toBeUndefined();
  });

  it("always wires `episodic` (every method carries its own agentId)", () => {
    expect(makeAdapter(false).episodic).toBeDefined();
  });

  it("always wires `claims` (neither assert nor query needs an adapter-level agentId)", () => {
    expect(makeAdapter(true).claims).toBeDefined();
    expect(makeAdapter(false).claims).toBeDefined();
  });
});

// ─── Working Memory ────────────────────────────────────────────────────────────

describe("working memory (WM)", () => {
  it("set(): happy path posts to /api/memory/working/:agentId with defaults applied", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          slotId: "goal",
          content: { x: 1 },
          importanceScore: 0.5,
          pinned: false,
          createdAt: "t",
        },
      }),
    );
    const adapter = makeAdapter();
    await adapter.working?.set("run-1", "goal", { x: 1 });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/memory/working/agent-007");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      sessionId: "run-1",
      slotId: "goal",
      content: { x: 1 },
      importanceScore: 0.5,
      pinned: false,
    });
  });

  it("set(): unhappy path — non-positive ttlMs throws MemoryValidationError without a fetch call", async () => {
    const adapter = makeAdapter();
    await expect(adapter.working?.set("run-1", "goal", "x", { ttlMs: 0 })).rejects.toThrow(
      MemoryValidationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("get(): happy path returns the slot content", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          slotId: "goal",
          content: "hello",
          importanceScore: 0.5,
          pinned: false,
          createdAt: "t",
        },
      }),
    );
    const adapter = makeAdapter();
    const value = await adapter.working?.get("run-1", "goal");
    expect(value).toBe("hello");
  });

  it("get(): unhappy path — 404 resolves to null, not a throw", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { success: false, error: "Slot not found" }));
    const adapter = makeAdapter();
    const value = await adapter.working?.get("run-1", "missing");
    expect(value).toBeNull();
  });

  it("get(): auth failure (401) throws BrainUnavailableError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(401, { success: false, error: "Authentication required" }),
    );
    const adapter = makeAdapter();
    await expect(adapter.working?.get("run-1", "goal")).rejects.toThrow(BrainUnavailableError);
  });

  it("list(): happy path maps every wire slot to WorkingMemorySlot", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: [
          { slotId: "a", content: 1, importanceScore: 0.5, pinned: false, createdAt: "t1" },
          { slotId: "b", content: 2, importanceScore: 0.8, pinned: true, createdAt: "t2" },
        ],
      }),
    );
    const adapter = makeAdapter();
    const slots = await adapter.working?.list("run-1");
    expect(slots).toHaveLength(2);
    expect(slots?.[1]).toEqual({
      slotId: "b",
      content: 2,
      importanceScore: 0.8,
      pinned: true,
      createdAt: "t2",
    });
  });

  it("list(): unhappy path — network error throws BrainUnavailableError", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = makeAdapter();
    await expect(adapter.working?.list("run-1")).rejects.toThrow(BrainUnavailableError);
  });

  it("delete(): happy path issues a DELETE request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { deleted: true } }));
    const adapter = makeAdapter();
    await adapter.working?.delete("run-1", "goal");
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("DELETE");
  });
});

// ─── Episodic Memory ────────────────────────────────────────────────────────────

describe("episodic memory (EM)", () => {
  it("append(): happy path posts to /api/memory/episodic/:agentId/events with sourceAgentId governance default", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "ev-1",
          session_id: "sess-1",
          agent_id: "agent-007",
          event_type: "tool_call",
          content: { tool: "grep" },
          importance_score: 0.5,
          source_agent_id: "agent-007",
          created_at: "2026-07-06T00:00:00Z",
        },
      }),
    );
    const adapter = makeAdapter(false);
    const id = await adapter.episodic?.append("agent-007", "sess-1", "tool_call", { tool: "grep" });
    expect(id).toBe("ev-1");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/memory/episodic/agent-007/events");
    const body = JSON.parse(init.body as string);
    expect(body.sourceAgentId).toBe("agent-007");
    expect(body.eventType).toBe("tool_call");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("traceId");
  });

  it("append(): unhappy path — empty string content throws MemoryValidationError without a fetch call", async () => {
    const adapter = makeAdapter(false);
    await expect(
      adapter.episodic?.append("agent-007", "sess-1", "tool_call", "   "),
    ).rejects.toThrow(MemoryValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("append(): unsupported metadata/artifacts/traceId are dropped with a console.warn, not silently ignored", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "ev-2",
          session_id: "sess-1",
          agent_id: "agent-007",
          event_type: "note",
          content: "hi",
          importance_score: 0.5,
          source_agent_id: "agent-007",
          created_at: "2026-07-06T00:00:00Z",
        },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter(false);
    await adapter.episodic?.append("agent-007", "sess-1", "note", "hi", {
      metadata: { k: "v" },
      traceId: "trace-1",
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("append(): 400 with a non-string error body (Zod validation) surfaces the real reason, not '[object Object]'", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, {
        success: false,
        error: { fieldErrors: { sessionId: ["Required"] }, formErrors: [] },
      }),
    );
    const adapter = makeAdapter(false);
    await expect(
      adapter.episodic?.append("agent-007", "sess-1", "tool_call", { tool: "grep" }),
    ).rejects.toThrow(/fieldErrors/);
  });

  it("query(): happy path filters by sessionId and maps snake_case wire fields to camelCase", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: [
          {
            id: "ev-1",
            session_id: "sess-1",
            agent_id: "agent-007",
            event_type: "tool_call",
            content: "x",
            importance_score: 0.9,
            source_agent_id: "agent-007",
            created_at: "2026-07-06T00:00:00Z",
          },
        ],
      }),
    );
    const adapter = makeAdapter(false);
    const events = await adapter.episodic?.query({ agentId: "agent-007", sessionId: "sess-1" });
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({ id: "ev-1", agentId: "agent-007", eventType: "tool_call" });

    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/memory/episodic/agent-007/events");
    expect(String(url)).toContain("session_id=sess-1");
  });

  it("query(): unhappy path — empty agentId throws MemoryValidationError without a fetch call", async () => {
    const adapter = makeAdapter(false);
    await expect(adapter.episodic?.query({ agentId: "" })).rejects.toThrow(MemoryValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("query(): server error (500) throws BrainUnavailableError", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { success: false, error: "internal error" }));
    const adapter = makeAdapter(false);
    await expect(
      adapter.episodic?.query({ agentId: "agent-007", sessionId: "sess-1" }),
    ).rejects.toThrow(BrainUnavailableError);
  });

  it("record(): delegates to append() with the event name as fallback content", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "ev-3",
          session_id: "sess-1",
          agent_id: "agent-007",
          event_type: "checkpoint",
          content: "checkpoint",
          importance_score: 0.5,
          source_agent_id: "agent-007",
          created_at: "2026-07-06T00:00:00Z",
        },
      }),
    );
    const adapter = makeAdapter(false);
    await adapter.episodic?.record("agent-007", "sess-1", "checkpoint");
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe("checkpoint");
  });

  it("since(): queries a time window from sinceMs to now and sorts descending", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: [
          {
            id: "ev-1",
            session_id: "sess-1",
            agent_id: "agent-007",
            event_type: "a",
            content: "x",
            importance_score: 0.5,
            source_agent_id: null,
            created_at: "2026-07-06T00:00:00Z",
          },
        ],
      }),
    );
    const adapter = makeAdapter(false);
    const entries = await adapter.episodic?.since("agent-007", Date.now() - 1000);
    expect(entries).toHaveLength(1);
    expect(entries?.[0].agentId).toBe("agent-007");
  });

  it("queryByTrace(): returns [] and warns — Brain does not persist trace_id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter(false);
    const result = await adapter.episodic?.queryByTrace("trace-xyz");
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── Claims ─────────────────────────────────────────────────────────────────

describe("claims", () => {
  it("assert(): happy path posts to /api/memory/claims with defaults applied", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: { id: "claim-1", created_at: "2026-07-06T00:00:00Z", entry_id: "entry-1" },
      }),
    );
    const adapter = makeAdapter(false);
    const id = await adapter.claims?.assert("Vauban", "targets", "Q3 2027 EVM adapter");
    expect(id).toBe("claim-1");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/memory/claims");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      subject: "Vauban",
      predicate: "targets",
      object: "Q3 2027 EVM adapter",
      claimSource: "agent_inference",
      confidence: 0.8,
    });
  });

  it("assert(): unhappy path — empty subject throws MemoryValidationError without a fetch call", async () => {
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.assert("  ", "predicate")).rejects.toThrow(MemoryValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("assert(): sends agentId (persisted to model_id, brain #101), drops scope with a warn", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: { id: "claim-2", created_at: "2026-07-06T00:00:00Z", entry_id: "entry-2" },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter(false);
    await adapter.claims?.assert("Vauban", "targets", "x", {
      agentId: "agent-007",
      scope: "shared",
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.agentId).toBe("agent-007"); // sent — Brain persists it to model_id
    expect(body).not.toHaveProperty("scope"); // still no wire field on the deployed schema
    expect(warnSpy).toHaveBeenCalled(); // warns for the dropped scope
    warnSpy.mockRestore();
  });

  it("assert(): agentId alone (no scope) is sent with no warn", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: { id: "claim-3", created_at: "2026-07-06T00:00:00Z", entry_id: "entry-3" },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = makeAdapter(false);
    await adapter.claims?.assert("Vauban", "targets", "x", { agentId: "narrator" });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.agentId).toBe("narrator");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("assert(): auth failure (401) throws BrainUnavailableError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(401, { success: false, error: "Authentication required" }),
    );
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.assert("Vauban", "targets")).rejects.toThrow(
      BrainUnavailableError,
    );
  });

  it("assert(): server-side validation failure (400) throws BrainUnavailableError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, {
        success: false,
        error: "entryId 'x' does not reference an existing knowledge entry",
      }),
    );
    const adapter = makeAdapter(false);
    await expect(
      adapter.claims?.assert("Vauban", "targets", undefined, { entryId: "x" }),
    ).rejects.toThrow(BrainUnavailableError);
  });

  it("assert(): network error throws BrainUnavailableError", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.assert("Vauban", "targets")).rejects.toThrow(
      BrainUnavailableError,
    );
  });

  it("query(): happy path posts to /api/memory/claims/query and maps snake_case wire fields", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        data: {
          claims: [
            {
              id: "claim-1",
              entry_id: "entry-1",
              subject: "Vauban",
              predicate: "targets",
              object: "Q3 2027 EVM adapter",
              confidence: 0.9,
              claim_source: "agent_inference",
              model_id: "agent-007",
              claim_status: "active",
              superseded_by: null,
              valid_from: null,
              valid_until: null,
              org_id: "org-1",
              created_at: "2026-07-06T00:00:00Z",
              updated_at: "2026-07-06T00:00:00Z",
            },
          ],
          total: 1,
        },
      }),
    );
    const adapter = makeAdapter(false);
    const claims = await adapter.claims?.query({ subject: "Vauban" });
    expect(claims).toHaveLength(1);
    expect(claims?.[0]).toMatchObject({
      id: "claim-1",
      subject: "Vauban",
      agentId: "agent-007",
      claimStatus: "active",
      scope: "private",
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/memory/claims/query");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ subject: "Vauban", claimStatus: "active", limit: 20 });
  });

  it("query(): unhappy path — none of subject/predicate/object/agentId throws MemoryValidationError without a fetch call", async () => {
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.query({})).rejects.toThrow(MemoryValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("query(): agentId-only hits the wire (sprint-936 relax; server support = brain #103)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, data: { claims: [], total: 0 } }),
    );
    const adapter = makeAdapter(false);
    const claims = await adapter.claims?.query({ agentId: "preste-rottgame", limit: 5 });
    expect(claims).toEqual([]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/memory/claims/query");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ agentId: "preste-rottgame", claimStatus: "active", limit: 5 });
  });

  it("query(): auth failure (401) throws BrainUnavailableError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(401, { success: false, error: "Authentication required" }),
    );
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.query({ subject: "Vauban" })).rejects.toThrow(
      BrainUnavailableError,
    );
  });

  it("query(): network error throws BrainUnavailableError", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.query({ subject: "Vauban" })).rejects.toThrow(
      BrainUnavailableError,
    );
  });
});

// ─── Semantic (LTM) — agent identity ──────────────────────────────────────────

describe("semantic (LTM) — archiveKnowledge agent identity", () => {
  it("tags the write with the adapter-level agentId by default (mirrors episodic's convention)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "entry-1",
          content: "hello",
          category: "pattern",
          tags: [],
          metadata: {},
          created_at: "2026-07-08T00:00:00Z",
        },
      }),
    );
    const adapter = makeAdapter(true); // agentId: "agent-007"

    await adapter.archiveKnowledge({ content: "hello" });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://brain.api.vauban.tech/api/knowledge");
    const body = JSON.parse(init.body as string);
    expect(body.source_agent_id).toBe("agent-007");
  });

  it("an explicit per-call source_agent_id overrides the adapter-level agentId", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "entry-2",
          content: "hello",
          category: "pattern",
          tags: [],
          metadata: {},
          created_at: "2026-07-08T00:00:00Z",
        },
      }),
    );
    const adapter = makeAdapter(true); // agentId: "agent-007"

    await adapter.archiveKnowledge({ content: "hello", source_agent_id: "forge-content-agent" });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.source_agent_id).toBe("forge-content-agent");
  });

  it("never fabricates an agent identity when the adapter has no agentId and none is passed per-call", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "entry-3",
          content: "hello",
          category: "pattern",
          tags: [],
          metadata: {},
          created_at: "2026-07-08T00:00:00Z",
        },
      }),
    );
    const adapter = makeAdapter(false); // no agentId

    await adapter.archiveKnowledge({ content: "hello" });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.source_agent_id).toBeUndefined();
  });
});

// ─── Injectable logger (command-center:sprint-1067:t3-brain-http-noise) ────

describe("logger option", () => {
  it("defaults to console.warn when no logger is supplied (zero-regression)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = makeAdapter(false);
    await expect(adapter.claims?.assert("Vauban", "targets")).rejects.toThrow(
      BrainUnavailableError,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[brain-http] fetch error on POST /api/memory/claims:"),
      "ECONNREFUSED",
    );
    warnSpy.mockRestore();
  });

  it("routes a transport failure through a supplied logger instead of console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.api.vauban.tech",
      brainId: "brain-test-uuid",
      apiKey: "test-api-key",
      logger,
    });
    await expect(adapter.claims?.assert("Vauban", "targets")).rejects.toThrow(
      BrainUnavailableError,
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("[brain-http] fetch error on POST /api/memory/claims:"),
      "ECONNREFUSED",
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("routes a dropped-field warning (episodic metadata) through a supplied logger", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = vi.fn();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(201, {
        success: true,
        data: {
          id: "ev-9",
          session_id: "sess-1",
          agent_id: "agent-007",
          event_type: "note",
          content: "hi",
          importance_score: 0.5,
          source_agent_id: "agent-007",
          created_at: "2026-07-06T00:00:00Z",
        },
      }),
    );
    const adapter = createHttpBrainAdapter({
      baseUrl: "https://brain.api.vauban.tech",
      brainId: "brain-test-uuid",
      apiKey: "test-api-key",
      logger,
    });
    await adapter.episodic?.append("agent-007", "sess-1", "note", "hi", {
      metadata: { k: "v" },
    });
    expect(logger).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("createBrainPortFromEnv forwards its logger param to the adapter", async () => {
    const savedUrl = process.env.BRAIN_URL;
    process.env.BRAIN_URL = "https://brain.api.vauban.tech";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    try {
      const port = createBrainPortFromEnv("agent-007", logger);
      await expect(port?.claims?.assert("Vauban", "targets")).rejects.toThrow(
        BrainUnavailableError,
      );
      expect(logger).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      if (savedUrl === undefined) delete process.env.BRAIN_URL;
      else process.env.BRAIN_URL = savedUrl;
    }
  });
});
