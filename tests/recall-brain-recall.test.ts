/**
 * recall/brain-recall — brainRecall() client tests.
 *
 * Promoted from apps/agents/forecaster/tests/recall/brain-recall.test.ts
 * per ADR-ECO-065 (sprint-805 Stage 2). Import paths updated; BrainChunk
 * renamed to RecallChunk throughout.
 *
 * Mock fetch to assert:
 *   - agentic path: POST /api/knowledge/search/agent, correct body, mapped result
 *   - fast path: GET /api/knowledge?q=..., mapped result, strategy_used="single-shot"
 *   - auto-gate: simple query → fast; multi-hop signals → agentic
 *   - degraded path: timeout / network error → EMPTY_RESULT, no throw
 *   - minSimilarity filter applied client-side
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerPort } from "../src/ports/index.js";
import { brainRecall, selectTier } from "../src/recall/brain-recall.js";

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  process.env.BRAIN_URL = "https://brain.test";
  process.env.BRAIN_RECALL_TIMEOUT_MS = "5000";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.BRAIN_URL;
  delete process.env.BRAIN_RECALL_TIMEOUT_MS;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const agentChunk = {
  id: "entry-001",
  content: "Paris is the capital of France.",
  hybrid_score: 0.85,
  cross_encoder_score: 0.92,
  similarity: 0.78,
  category: "fact",
  tags: ["geography"],
  created_at: "2026-01-01T00:00:00Z",
  brain_id: null,
  brain_slug: null,
};

const agentResponse = {
  success: true,
  data: {
    answer: "Paris",
    chunks: [agentChunk],
    strategy_used: "direct",
    hops_used: 1,
    queries_used: ["capital of France"],
    router_reason: null,
  },
};

const fastEntry = {
  id: "entry-002",
  content: "Lyon is the third city of France.",
  category: "fact",
  tags: [],
  created_at: "2026-02-01T00:00:00Z",
  brain_id: null,
  brain_slug: null,
  similarity: 0.65,
};

const fastResponse = {
  entries: [fastEntry],
  total: 1,
};

// ─── Agentic path ─────────────────────────────────────────────────────────────

describe("brainRecall — agentic tier", () => {
  it("POSTs to /api/knowledge/search/agent with correct body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(agentResponse));

    await brainRecall("capital of France vs Spain", {
      tier: "agentic",
      mode: "chunks",
      topK: 5,
      brainIds: ["brain-uuid"],
      tags: ["geography"],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://brain.test/api/knowledge/search/agent");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.question).toBe("capital of France vs Spain");
    expect(body.top_k).toBe(5);
    expect(body.brain_ids).toEqual(["brain-uuid"]);
    expect(body.tags).toEqual(["geography"]);
  });

  it("maps agentic response to RecallResult correctly", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(agentResponse));

    const result = await brainRecall("capital of France vs Spain", {
      tier: "agentic",
      mode: "answer",
    });

    expect(result.strategy_used).toBe("direct");
    expect(result.hops_used).toBe(1);
    expect(result.answer).toBe("Paris");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.id).toBe("entry-001");
    expect(result.chunks[0]!.hybrid_score).toBe(0.85);
    expect(result.refs).toEqual(["entry-001"]);
    // freshness marker present with stale:false (no t_valid_to → evergreen)
    expect(result.freshness).toHaveLength(1);
    expect(result.freshness[0]!.entryId).toBe("entry-001");
    expect(result.freshness[0]!.stale).toBe(false);
  });

  it("returns null answer when mode=chunks", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(agentResponse));

    const result = await brainRecall("capital of France", {
      tier: "agentic",
      mode: "chunks",
    });

    expect(result.answer).toBeNull();
  });

  it("applies minSimilarity filter client-side on agentic chunks", async () => {
    const lowScoreChunk = {
      ...agentChunk,
      id: "low",
      cross_encoder_score: 0.3,
      hybrid_score: null,
      similarity: null,
    };
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          ...agentResponse.data,
          chunks: [agentChunk, lowScoreChunk],
        },
      }),
    );

    const result = await brainRecall("capital of France", {
      tier: "agentic",
      mode: "chunks",
      minSimilarity: 0.5,
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.id).toBe("entry-001");
  });
});

// ─── Fast path ────────────────────────────────────────────────────────────────

describe("brainRecall — fast tier", () => {
  it("GETs /api/knowledge with q param", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(fastResponse));

    await brainRecall("Lyon", { tier: "fast", mode: "chunks", topK: 3 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/api/knowledge");
    expect(u.searchParams.get("q")).toBe("Lyon");
    expect(u.searchParams.get("limit")).toBe("3");
  });

  it("maps fast response to RecallResult with strategy_used=single-shot", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(fastResponse));

    const result = await brainRecall("Lyon", { tier: "fast", mode: "chunks" });

    expect(result.strategy_used).toBe("single-shot");
    expect(result.hops_used).toBe(0);
    expect(result.answer).toBeNull();
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.id).toBe("entry-002");
    expect(result.refs).toEqual(["entry-002"]);
  });

  it("forwards brainIds as brain_id param (first ID)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ entries: [], total: 0 }));

    await brainRecall("test", {
      tier: "fast",
      mode: "chunks",
      brainIds: ["brain-xyz"],
    });

    const [url] = mockFetch.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.searchParams.get("brain_id")).toBe("brain-xyz");
  });
});

// ─── Auto-gate heuristic ──────────────────────────────────────────────────────

describe("selectTier (auto-gate heuristic)", () => {
  it("routes simple short query → fast", () => {
    expect(selectTier("What is Paris?")).toBe("fast");
  });

  it("routes query with conjunction keyword → agentic", () => {
    expect(selectTier("Paris and Lyon population")).toBe("agentic");
    expect(selectTier("France vs Germany GDP")).toBe("agentic");
    expect(selectTier("compare Paris and Madrid")).toBe("agentic");
    expect(selectTier("first visit Paris, then Lyon")).toBe("agentic");
  });

  it("routes query with multiple question marks → agentic", () => {
    expect(selectTier("What is Paris? What is Lyon?")).toBe("agentic");
  });

  it("routes long query (>120 chars) → agentic", () => {
    const long = "a".repeat(121);
    expect(selectTier(long)).toBe("agentic");
  });

  it("boundary: exactly 120 chars → fast", () => {
    const boundary = "a".repeat(120);
    expect(selectTier(boundary)).toBe("fast");
  });
});

describe("brainRecall — auto tier routes correctly", () => {
  it("simple query hits fast path (GET)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(fastResponse));

    await brainRecall("What is Paris?", { tier: "auto", mode: "chunks" });

    const [url] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/knowledge?");
  });

  it("multi-hop query hits agentic path (POST)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(agentResponse));

    await brainRecall("Paris and Lyon", { tier: "auto", mode: "chunks" });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/knowledge/search/agent");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("default tier (omitted) behaves as auto", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(fastResponse));

    await brainRecall("simple query", { mode: "chunks" });

    const [url] = mockFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/knowledge?");
  });
});

// ─── Degraded path ────────────────────────────────────────────────────────────

describe("brainRecall — degraded path", () => {
  it("returns EMPTY_RESULT on network error, does not throw", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await brainRecall("test", { tier: "fast", mode: "chunks" });

    expect(result.strategy_used).toBe("degraded");
    expect(result.chunks).toEqual([]);
    expect(result.answer).toBeNull();
    expect(result.hops_used).toBe(0);
  });

  it("returns EMPTY_RESULT on HTTP 500, does not throw", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "internal" }, 500));

    const result = await brainRecall("test", {
      tier: "agentic",
      mode: "chunks",
    });

    expect(result.strategy_used).toBe("degraded");
  });

  it("returns EMPTY_RESULT on abort (timeout), does not throw", async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );

    const result = await brainRecall("test", { mode: "chunks" });

    expect(result.strategy_used).toBe("degraded");
    expect(result.chunks).toHaveLength(0);
  });

  it("calls logger.warn on degraded path", async () => {
    const warnSpy = vi.fn();
    const testLogger: LoggerPort = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    };
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await brainRecall("test", { mode: "chunks" }, testLogger);

    expect(warnSpy).toHaveBeenCalledOnce();
    const [meta, msg] = warnSpy.mock.calls[0]!;
    expect(msg).toBe("brain_recall.degraded");
    expect((meta as Record<string, unknown>).err).toContain("ECONNREFUSED");
  });
});

// ─── Bi-temporal freshness (ADR-ECO-065) ─────────────────────────────────────

describe("brainRecall — bi-temporal freshness markers", () => {
  it("flags a superseded chunk (past t_valid_to) as stale but still returns it", async () => {
    const staleChunk = {
      id: "stale-001",
      content: "Outdated fact about Paris.",
      hybrid_score: 0.75,
      cross_encoder_score: null,
      similarity: 0.7,
      category: "fact",
      tags: ["geography"],
      created_at: "2024-01-01T00:00:00Z",
      brain_id: null,
      brain_slug: null,
      // t_valid_to is in the past → superseded
      t_valid_from: "2024-01-01T00:00:00Z",
      t_valid_to: "2024-06-01T00:00:00Z",
    };

    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          answer: null,
          chunks: [staleChunk],
          strategy_used: "direct",
          hops_used: 1,
          queries_used: ["Paris fact"],
          router_reason: null,
        },
      }),
    );

    const result = await brainRecall("Paris fact", {
      tier: "agentic",
      mode: "chunks",
    });

    // Stale chunk is RETURNED (not dropped)
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.id).toBe("stale-001");

    // Freshness marker flags it stale
    expect(result.freshness).toHaveLength(1);
    const marker = result.freshness[0]!;
    expect(marker.entryId).toBe("stale-001");
    expect(marker.stale).toBe(true);
    expect(marker.validFrom).toBe("2024-01-01T00:00:00Z");
    expect(marker.validUntil).toBe("2024-06-01T00:00:00Z");
  });

  it("marks a chunk with future t_valid_to as non-stale", async () => {
    const futureChunk = {
      id: "fresh-001",
      content: "Current fact about Paris.",
      hybrid_score: 0.8,
      cross_encoder_score: null,
      similarity: 0.75,
      category: "fact",
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      brain_id: null,
      brain_slug: null,
      t_valid_from: "2026-01-01T00:00:00Z",
      t_valid_to: "2030-12-31T00:00:00Z",
    };

    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          answer: null,
          chunks: [futureChunk],
          strategy_used: "direct",
          hops_used: 1,
          queries_used: ["Paris current"],
          router_reason: null,
        },
      }),
    );

    const result = await brainRecall("Paris current", {
      tier: "agentic",
      mode: "chunks",
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.freshness).toHaveLength(1);
    expect(result.freshness[0]!.stale).toBe(false);
    expect(result.freshness[0]!.validUntil).toBe("2030-12-31T00:00:00Z");
  });

  it("marks a chunk with no t_valid_to as non-stale (evergreen)", async () => {
    const evergreenChunk = {
      id: "ever-001",
      content: "Evergreen fact.",
      hybrid_score: 0.9,
      cross_encoder_score: null,
      similarity: 0.85,
      category: "fact",
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
      brain_id: null,
      brain_slug: null,
      t_valid_from: null,
      t_valid_to: null,
    };

    mockFetch.mockResolvedValueOnce(
      mockResponse({
        success: true,
        data: {
          answer: null,
          chunks: [evergreenChunk],
          strategy_used: "direct",
          hops_used: 1,
          queries_used: ["evergreen"],
          router_reason: null,
        },
      }),
    );

    const result = await brainRecall("evergreen", {
      tier: "agentic",
      mode: "chunks",
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.freshness).toHaveLength(1);
    const marker = result.freshness[0]!;
    expect(marker.stale).toBe(false);
    expect(marker.validFrom).toBeUndefined();
    expect(marker.validUntil).toBeUndefined();
  });
});

// ─── BrainRecallConfig.baseUrl ────────────────────────────────────────────────
//
// AJOUTE le 2026-08-29. Sans point de terminaison explicite, le seul moyen pour
// un appelant multi-Brain d'atteindre le sien etait de poser
// `process.env.BRAIN_URL` autour de l'appel, ce que faisait
// `packages/cli/src/brain-http-client.ts` : voir le commentaire de `recall()`
// la-bas pour les trois corruptions mesurees.
describe("brainRecall ; BrainRecallConfig.baseUrl", () => {
  it("interroge le baseUrl fourni, pas BRAIN_URL", async () => {
    process.env.BRAIN_URL = "https://brain-env.test";
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    await brainRecall("capital", { mode: "chunks", tier: "fast" }, undefined, {
      baseUrl: "https://brain-explicite.test",
    });

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url.startsWith("https://brain-explicite.test/api/knowledge")).toBe(true);
  });

  it("le baseUrl explicite vaut aussi pour le chemin agentique", async () => {
    process.env.BRAIN_URL = "https://brain-env.test";
    mockFetch.mockResolvedValueOnce(mockResponse({ data: { chunks: [] } }));

    await brainRecall("capital", { mode: "chunks", tier: "agentic" }, undefined, {
      baseUrl: "https://brain-explicite.test",
    });

    expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
      "https://brain-explicite.test/api/knowledge/search/agent",
    );
  });

  it("retombe sur BRAIN_URL quand aucun baseUrl n'est fourni", async () => {
    process.env.BRAIN_URL = "https://brain-env.test";
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    await brainRecall("capital", { mode: "chunks", tier: "fast" });

    expect(String(mockFetch.mock.calls[0]?.[0]).startsWith("https://brain-env.test/")).toBe(true);
  });

  it("le baseUrl explicite suffit quand BRAIN_URL n'est pas pose du tout", async () => {
    delete process.env.BRAIN_URL;
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    const result = await brainRecall("capital", { mode: "chunks", tier: "fast" }, undefined, {
      baseUrl: "https://brain-explicite.test",
    });

    // Sans le baseUrl, getBrainUrl() jette et brainRecall rend le degrade.
    expect(result.strategy_used).toBe("single-shot");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("n'ecrit jamais dans process.env", async () => {
    delete process.env.BRAIN_URL;
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    await brainRecall("capital", { mode: "chunks", tier: "fast" }, undefined, {
      baseUrl: "https://brain-explicite.test",
    });

    expect(process.env.BRAIN_URL).toBeUndefined();
  });

  it("deux appels concurrents sur des Brains differents n'interferent pas", async () => {
    delete process.env.BRAIN_URL;
    mockFetch.mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(mockResponse({ data: [] })), 5),
        ) as Promise<Response>,
    );

    await Promise.all([
      brainRecall("a", { mode: "chunks", tier: "fast" }, undefined, {
        baseUrl: "https://brain-A.test",
      }),
      brainRecall("b", { mode: "chunks", tier: "fast" }, undefined, {
        baseUrl: "https://brain-B.test",
      }),
    ]);

    const hosts = mockFetch.mock.calls.map((c) => new URL(String(c[0])).host).sort();
    expect(hosts).toEqual(["brain-a.test", "brain-b.test"]);
  });
});
