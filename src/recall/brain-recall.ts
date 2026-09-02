/**
 * brainRecall — Brain agentic retrieval client.
 *
 * Promoted from apps/agents/forecaster/src/recall/brain-recall.ts to SDK port
 * per ADR-ECO-065 (sprint-805 Stage 2). L1 prototype evidence:
 * docs/agentic-rag/L1-evidence-forecaster.md.
 *
 * Wraps Brain's two retrieval endpoints:
 *
 *   fast    — GET /api/knowledge?q=<query>&limit=<topK>
 *             Single-hop FTS + vector search. Low latency, low cost.
 *             Returns KnowledgeEntry[] mapped to RecallChunk[].
 *
 *   agentic — POST /api/knowledge/search/agent
 *             MemMachine-style multi-hop router (direct/chain/split).
 *             Returns synthesised answer + ranked chunks.
 *             Body: { question, top_k?, brain_ids?, tags? }
 *
 * Auto-gate heuristic (tier="auto"):
 *   Multi-hop signals → "agentic":
 *     - Multiple entities joined by "and", "vs", "compare", "then"
 *     - More than one "?" in the query
 *     - Query length > 120 chars
 *   Otherwise → "fast" (default cheap path)
 *
 * Resilience: 8 s AbortController timeout. Any HTTP/network/timeout error
 * returns EMPTY_RESULT (degraded) — brainRecall() NEVER throws.
 *
 * Config: the Brain endpoint comes from `BrainRecallConfig.baseUrl` when the
 * caller passes one, else from the BRAIN_URL env var (no hardcoded URLs).
 * Timeout override via BRAIN_RECALL_TIMEOUT_MS env var.
 *
 * @public
 */

import { fetchJson as sharedFetchJson } from "../http/fetch-json.js";
import type { LoggerPort } from "../ports/index.js";
import { noopLogger } from "../ports/index.js";
import type {
  BrainRecallPort,
  FreshnessMarker,
  RecallChunk,
  RecallOptions,
  RecallResult,
} from "./types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TOP_K = 10;

function getTimeoutMs(): number {
  const v = Number(process.env.BRAIN_RECALL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * Per-call configuration, distinct from `RecallOptions`, which describes the
 * QUERY. This describes where to ask.
 * @public
 */
export interface BrainRecallConfig {
  /**
   * Brain endpoint for this call. Defaults to the BRAIN_URL env var.
   *
   * Exists because the alternative a caller is otherwise pushed into is to set
   * `process.env.BRAIN_URL` around the call, which is what
   * `packages/cli/src/brain-http-client.ts` did until 2026-08-29. Measured
   * consequences of that pattern, all three reproduced by running it: two
   * concurrent recalls with different endpoints both queried the FIRST one; a
   * client whose baseUrl differed from an already-set BRAIN_URL silently
   * queried the env one instead of its own; and the restoring `finally`
   * deleted a BRAIN_URL the host had set meanwhile. An endpoint is an argument,
   * not ambient state.
   */
  readonly baseUrl?: string;
}

function getBrainUrl(override?: string): string {
  const url = override ?? process.env.BRAIN_URL;
  if (!url) throw new Error("BRAIN_RECALL: BRAIN_URL env var is not set");
  return url.replace(/\/+$/, "");
}

// ─── Degraded result ──────────────────────────────────────────────────────────

const EMPTY_RESULT: RecallResult = {
  chunks: [],
  answer: null,
  strategy_used: "degraded",
  hops_used: 0,
  refs: [],
  freshness: [],
};

// ─── Auto-gate heuristic ──────────────────────────────────────────────────────

/**
 * Client-side multi-hop complexity heuristic (tier="auto").
 *
 * Routes to "agentic" when ANY of these signals are present:
 *   1. Conjunction/comparison keywords: "and", "vs", "compare", "then"
 *      between likely entities (word-boundary match, case-insensitive).
 *   2. More than one "?" character (compound questions).
 *   3. Query length > 120 chars (high information density → likely multi-hop).
 *
 * Default: "fast" (cheap single-hop path).
 *
 * Rationale: a single conjunction is often comparison or sequence, both of
 * which benefit from ChainOfQuery or SplitQuery. Length > 120 chars
 * correlates with compound questions that exhaust single-hop retrieval.
 * @public
 */
export function selectTier(query: string): "fast" | "agentic" {
  if (query.length > 120) return "agentic";
  if ((query.match(/\?/g) ?? []).length > 1) return "agentic";
  if (/\b(and|vs|compare|then)\b/i.test(query)) return "agentic";
  return "fast";
}

// ─── Response types (Brain HTTP API) ─────────────────────────────────────────

interface KnowledgeEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  created_at?: string;
  brain_id?: string | null;
  brain_slug?: string | null;
  similarity?: number | null;
  hybrid_score?: number | null;
  cross_encoder_score?: number | null;
  /** Bi-temporal validity window (ADR-ECO-065). ISO date strings or null. */
  t_valid_from?: string | null;
  t_valid_to?: string | null;
  event_date?: string | null;
  [key: string]: unknown;
}

interface AgentSearchData {
  answer: string | null;
  chunks: unknown[];
  strategy_used: string;
  hops_used: number;
  queries_used?: string[];
  router_reason?: string | null;
}

interface AgentSearchResponse {
  success: boolean;
  data: AgentSearchData;
}

interface KnowledgeListResponse {
  entries?: KnowledgeEntry[];
  data?: KnowledgeEntry[];
  total?: number;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function mapEntryToChunk(e: KnowledgeEntry): RecallChunk {
  return {
    id: typeof e.id === "string" ? e.id : String(e.id),
    content: typeof e.content === "string" ? e.content : "",
    hybrid_score: typeof e.hybrid_score === "number" ? e.hybrid_score : null,
    cross_encoder_score: typeof e.cross_encoder_score === "number" ? e.cross_encoder_score : null,
    similarity: typeof e.similarity === "number" ? e.similarity : null,
    category: typeof e.category === "string" ? e.category : "",
    tags: Array.isArray(e.tags)
      ? (e.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    created_at: typeof e.created_at === "string" ? e.created_at : "",
    brain_id: typeof e.brain_id === "string" ? e.brain_id : e.brain_id === null ? null : null,
    brain_slug:
      typeof e.brain_slug === "string" ? e.brain_slug : e.brain_slug === null ? null : null,
  };
}

function mapAgentChunk(raw: unknown): RecallChunk {
  if (typeof raw !== "object" || raw === null) {
    return {
      id: "",
      content: "",
      hybrid_score: null,
      cross_encoder_score: null,
      similarity: null,
      category: "",
      tags: [],
      created_at: "",
      brain_id: null,
      brain_slug: null,
    };
  }
  return mapEntryToChunk(raw as KnowledgeEntry);
}

function applyMinSimilarity(chunks: RecallChunk[], minSimilarity: number): RecallChunk[] {
  if (minSimilarity <= 0) return chunks;
  return chunks.filter((c) => {
    const score = c.cross_encoder_score ?? c.hybrid_score ?? c.similarity ?? 1;
    return score >= minSimilarity;
  });
}

/**
 * Build per-chunk FreshnessMarkers from the temporal metadata returned by Brain.
 *
 * Zep-pattern bi-temporal freshness (ADR-ECO-065):
 *   - validFrom  = t_valid_from  (earliest valid time)
 *   - validUntil = t_valid_to    (supersession timestamp)
 *   - stale      = t_valid_to is set AND is in the past (UTC now)
 *
 * Stale facts are FLAGGED, not removed. The consumer decides what to do.
 * Chunks with no validity window (null t_valid_from + null t_valid_to) are
 * returned as non-stale markers (no TTL set = treat as evergreen).
 */
function computeFreshness(rawChunks: KnowledgeEntry[]): FreshnessMarker[] {
  const now = Date.now();
  return rawChunks.map((e) => {
    const validFrom = typeof e.t_valid_from === "string" ? e.t_valid_from : undefined;
    const validUntil = typeof e.t_valid_to === "string" ? e.t_valid_to : undefined;
    const stale = validUntil !== undefined && new Date(validUntil).getTime() < now;
    return {
      entryId: typeof e.id === "string" ? e.id : String(e.id),
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validUntil !== undefined ? { validUntil } : {}),
      stale,
    } satisfies FreshnessMarker;
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// brainRecall() catches every error from this (network, HTTP, JSON parse,
// abort) and degrades to EMPTY_RESULT — see the try/catch below.
async function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  return sharedFetchJson<T>(
    url,
    { ...init, signal },
    { label: "Brain API", bodySnippetLength: 200 },
  );
}

// ─── Fast path ────────────────────────────────────────────────────────────────

async function recallFast(
  query: string,
  opts: RecallOptions,
  signal: AbortSignal,
  baseUrlOverride?: string,
): Promise<RecallResult> {
  const baseUrl = getBrainUrl(baseUrlOverride);
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(opts.topK ?? DEFAULT_TOP_K));
  if (opts.brainIds?.length) params.set("brain_id", opts.brainIds[0]);
  if (opts.tags?.length) params.set("tags", opts.tags.join(","));

  const data = await fetchJson<KnowledgeListResponse>(
    `${baseUrl}/api/knowledge?${params.toString()}`,
    { method: "GET" },
    signal,
  );

  const entries: KnowledgeEntry[] = data.entries ?? data.data ?? [];
  let chunks = entries.map(mapEntryToChunk);
  chunks = applyMinSimilarity(chunks, opts.minSimilarity ?? 0);
  const filtered = entries.filter((e) =>
    chunks.some((c) => c.id === (typeof e.id === "string" ? e.id : String(e.id))),
  );

  return {
    chunks,
    answer: null,
    strategy_used: "single-shot",
    hops_used: 0,
    refs: chunks.map((c) => c.id),
    freshness: computeFreshness(filtered),
  };
}

// ─── Agentic path ─────────────────────────────────────────────────────────────

async function recallAgentic(
  query: string,
  opts: RecallOptions,
  signal: AbortSignal,
  baseUrlOverride?: string,
): Promise<RecallResult> {
  const baseUrl = getBrainUrl(baseUrlOverride);

  const body: Record<string, unknown> = {
    question: query,
  };
  if (opts.topK != null) body.top_k = opts.topK;
  if (opts.brainIds?.length) body.brain_ids = Array.from(opts.brainIds);
  if (opts.tags?.length) body.tags = Array.from(opts.tags);

  const response = await fetchJson<AgentSearchResponse>(
    `${baseUrl}/api/knowledge/search/agent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );

  const d = response.data;
  const rawChunks = (d.chunks ?? []).filter(
    (r): r is KnowledgeEntry => typeof r === "object" && r !== null,
  );
  let chunks = rawChunks.map(mapAgentChunk);
  chunks = applyMinSimilarity(chunks, opts.minSimilarity ?? 0);
  const filteredRaw = rawChunks.filter((e) =>
    chunks.some((c) => c.id === (typeof e.id === "string" ? e.id : String(e.id))),
  );

  const answer = opts.mode === "answer" && typeof d.answer === "string" ? d.answer : null;

  return {
    chunks,
    answer,
    strategy_used: typeof d.strategy_used === "string" ? d.strategy_used : "direct",
    hops_used: typeof d.hops_used === "number" ? d.hops_used : 0,
    refs: chunks.map((c) => c.id),
    freshness: computeFreshness(filteredRaw),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recall memory from Brain.
 *
 * Never throws. Returns EMPTY_RESULT on any error (timeout, network, Brain
 * unavailable). Logs a warning via the provided logger on error.
 * @public
 */
export async function brainRecall(
  query: string,
  opts: RecallOptions,
  logger: LoggerPort = noopLogger,
  config: BrainRecallConfig = {},
): Promise<RecallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const tier = opts.tier === "auto" || opts.tier == null ? selectTier(query) : opts.tier;

    if (tier === "fast") {
      return await recallFast(query, opts, controller.signal, config.baseUrl);
    }
    return await recallAgentic(query, opts, controller.signal, config.baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    logger.warn(
      {
        query: query.slice(0, 80),
        tier: opts.tier ?? "auto",
        timeout: isTimeout,
        err: message,
      },
      "brain_recall.degraded",
    );
    return EMPTY_RESULT;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BrainRecallPort implementation.
 *
 * `logger` is optional — defaults to noopLogger.
 * Inject a real logger at construction time for production use.
 * @internal
 */
export function createBrainRecallImpl(
  logger: LoggerPort = noopLogger,
  config: BrainRecallConfig = {},
): BrainRecallPort {
  return {
    recall(query: string, opts: RecallOptions): Promise<RecallResult> {
      return brainRecall(query, opts, logger, config);
    },
  };
}

/**
 * Default BrainRecallPort instance using noopLogger.
 * Production host should create its own via createBrainRecallImpl(realLogger).
 * @internal
 */
export const brainRecallImpl: BrainRecallPort = createBrainRecallImpl();
