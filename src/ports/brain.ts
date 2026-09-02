/**
 * BrainPort — knowledge archival + retrieval contract (4 memory tiers +
 * a verifiable Claims plane).
 *
 * Tier 1 — working: get/set with scope='run' + ttlMs auto-expire (A6, sprint-562);
 *   extended with list() + V12-aligned slot fields (sprint-895, ADR-ECO-114).
 * Tier 2 — episodic: since/record per agentId (A6, sprint-562);
 *   extended with append()/query() matching episodic_append/episodic_query
 *   (sprint-895, ADR-ECO-114).
 * Tier 3 — semantic: query/archive shared across agents (C4, sprint-564).
 * Tier 4 — procedural: resolveSkills for learned/private/shared skills (C4, sprint-564).
 * Claims  — verifiable, time-bounded (subject, predicate, object) assertions,
 *   mirroring claim_assert/claim_query (sprint-895, ADR-ECO-114).
 *
 * Field shapes for working/episodic/claims are verified against
 * brain-protocol/docs/using-v12-memory.md (deployed tool reality) and
 * brain-protocol/docs/memory-contract-v12.md (normative schema) — see the
 * per-type doc comments below for the exact source + any deployed-vs-normative
 * divergence (e.g. `eventType` is a free string on the deployed tool, not the
 * stricter enum in the normative contract).
 * @public
 */

export interface BrainEntryInput {
  content: string;
  content_type?: string;
  author?: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  metadata?: Record<string, unknown>;
  brain_id?: string;
  /**
   * Identifier of the agent producing this entry. Optional per-call override;
   * when omitted, `HttpBrainAdapter.archiveKnowledge` falls back to the
   * adapter-level `agentId` (see `HttpBrainAdapterOptions.agentId`), mirroring
   * the episodic plane's "every write through this adapter is agent-generated"
   * convention. Never fabricated when both are absent.
   */
  source_agent_id?: string;
  /**
   * ROUTING field, not a wire field: names which Brain this write is for, when
   * the port is a `MultiBrainPort` (`adapters/multi-brain.ts`). Omit for the
   * default destination.
   *
   * A `MultiBrainPort` refuses an unknown name and strips this field before
   * delegating, so no adapter downstream ever sends it. A SINGLE-Brain adapter
   * that receives a value here THROWS rather than ignoring it: quietly writing
   * to its own Brain a note the caller addressed elsewhere is precisely the
   * misfiling the multi-Brain write rule exists to prevent, and the return
   * value would say "saved".
   */
  brain?: string;
}

/** @public */
export interface BrainEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

/** @public */
export interface BrainQueryFilters {
  category?: string;
  tags?: string[];
  limit?: number;
  [key: string]: unknown;
}

// ─── Tier 1: Working memory ──────────────────────────────────────────────────

/**
 * A working memory slot as returned by list()/working_memory_list.
 * Aligns to `WorkingMemorySlot` (brain-protocol/docs/memory-contract-v12.md §1.1)
 * and the deployed `working_memory_list` tool (docs/using-v12-memory.md §1).
 * @public
 */
export interface WorkingMemorySlot {
  /** Slot identifier, unique within (runId/sessionId). Aligns to V12 `slotId`. */
  slotId: string;
  /** Slot payload — string or JSON object (V12 `content`). */
  content: unknown;
  /** 0-1 salience score; drives eviction order + WM->EM promotion eligibility. */
  importanceScore: number;
  /** Bypasses TTL + eviction until explicitly unpinned (V12 pin rule, §2.3). */
  pinned: boolean;
  /** ISO-8601 slot creation time. */
  createdAt: string;
}

/** @public */
export interface WorkingMemorySetOptions {
  /**
   * Time-to-live in milliseconds. Ignored (slot never expires) when
   * `pinned: true`. Default 300_000 (5min); must be a positive number.
   */
  ttlMs?: number;
  /** 0-1 salience score (V12 `importanceScore`). Default 0.5. */
  importanceScore?: number;
  /** Bypasses TTL + eviction until explicitly unpinned. Default false. */
  pinned?: boolean;
}

/**
 * Working Memory — the session scratchpad. `runId` plays the role of the V12
 * `sessionId` (a UUID in the deployed schema; this port does not enforce the
 * UUID format at the type/runtime level — that is a wire-boundary concern for
 * an HTTP-backed implementation, not the in-memory test double).
 * @public
 */
export interface WorkingMemoryPort {
  /** Write a slot. `key` aligns to the V12 `slotId`/`slotKey`. */
  set(runId: string, key: string, value: unknown, opts?: WorkingMemorySetOptions): Promise<void>;
  get(runId: string, key: string): Promise<unknown>;
  delete(runId: string, key: string): Promise<void>;
  /**
   * List all live (non-expired) slots for a run/session — mirrors
   * `working_memory_list` (brain-protocol/docs/using-v12-memory.md §1).
   * ADDITIVE (sprint-895) — existing set/get/delete callers are unaffected.
   */
  list(runId: string): Promise<WorkingMemorySlot[]>;
}

interface WorkingMemoryRow {
  content: unknown;
  /** `Number.POSITIVE_INFINITY` when pinned (never expires). */
  expiresAt: number;
  importanceScore: number;
  pinned: boolean;
  createdAt: string;
}

export class InMemoryWorkingMemory implements WorkingMemoryPort {
  private sessions = new Map<string, Map<string, WorkingMemoryRow>>();

  async set(
    runId: string,
    key: string,
    value: unknown,
    opts?: WorkingMemorySetOptions,
  ): Promise<void> {
    if (opts?.ttlMs !== undefined && opts.ttlMs <= 0) {
      throw new MemoryValidationError("ttlMs must be a positive number of milliseconds");
    }
    const pinned = opts?.pinned ?? false;
    const row: WorkingMemoryRow = {
      content: value,
      expiresAt: pinned ? Number.POSITIVE_INFINITY : Date.now() + (opts?.ttlMs ?? 300_000),
      importanceScore: opts?.importanceScore ?? 0.5,
      pinned,
      createdAt: new Date().toISOString(),
    };
    let session = this.sessions.get(runId);
    if (!session) {
      session = new Map();
      this.sessions.set(runId, session);
    }
    session.set(key, row);
  }

  async get(runId: string, key: string): Promise<unknown> {
    const session = this.sessions.get(runId);
    const row = session?.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      session?.delete(key);
      return null;
    }
    return row.content;
  }

  async delete(runId: string, key: string): Promise<void> {
    this.sessions.get(runId)?.delete(key);
  }

  async list(runId: string): Promise<WorkingMemorySlot[]> {
    const session = this.sessions.get(runId);
    if (!session) return [];
    const now = Date.now();
    const live: WorkingMemorySlot[] = [];
    for (const [slotId, row] of session) {
      if (now > row.expiresAt) {
        session.delete(slotId);
        continue;
      }
      live.push({
        slotId,
        content: row.content,
        importanceScore: row.importanceScore,
        pinned: row.pinned,
        createdAt: row.createdAt,
      });
    }
    return live;
  }
}

// ─── Tier 2: Episodic memory ─────────────────────────────────────────────────

/** @public */
export interface EpisodicMemoryEntry {
  agentId: string;
  runId: string;
  event: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  /**
   * OTel trace ID associated with the run that produced this entry.
   * Optional for backward compatibility — existing entries without traceId
   * are never returned by queryByTrace.
   *
   * DB impact: migration 037_episodic_indexed_by_trace.sql adds
   * `trace_id TEXT` column + `idx_episodic_trace_id` B-tree index
   * on `episodic_memory(trace_id)`.
   */
  traceId?: string;
}

/**
 * Options for append() — mirrors `episodic_append`
 * (brain-protocol/docs/memory-contract-v12.md §5), minus the fields already
 * carried as positional args (agentId/sessionId/eventType/content).
 * @public
 */
export interface EpisodicAppendOptions {
  /** 0-1 salience score. Default 0.5. Drives EM->LTM promotion eligibility. */
  importanceScore?: number;
  /** URIs of artifacts produced alongside this event. */
  artifacts?: string[];
  /** Additional structured payload distinct from `content` (V12 `metadata`). */
  metadata?: Record<string, unknown>;
  /**
   * OTel trace ID correlation key. Existing SDK convention (see queryByTrace);
   * not a field of the deployed episodic_append tool.
   */
  traceId?: string;
}

/**
 * An episodic event as returned by query()/episodic_query. Aligns to
 * `EpisodicEvent` (brain-protocol/docs/memory-contract-v12.md §1.2) using the
 * MCP tool's camelCase field names.
 * @public
 */
export interface EpisodicEvent {
  id: string;
  agentId: string;
  sessionId: string;
  /**
   * Free string on the DEPLOYED `episodic_append` tool (verified live
   * 2026-07-06, docs/using-v12-memory.md §2) — default "message". The
   * normative contract (§1.2) additionally documents a stricter enum; the
   * live tool does not enforce it, so this type does not either.
   */
  eventType: string;
  content: string | Record<string, unknown>;
  importanceScore: number;
  artifacts?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Filter for query()/episodic_query. `agentId` is required; filter by
 * `sessionId` (chronological session replay) or a `[timerangeStart,
 * timerangeEnd]` window (docs/using-v12-memory.md §2).
 * @public
 */
export interface EpisodicQueryFilter {
  agentId: string;
  sessionId?: string;
  timerangeStart?: string;
  timerangeEnd?: string;
  eventTypes?: string[];
  minImportance?: number;
  limit?: number;
}

/** @public */
export interface EpisodicMemoryPort {
  /**
   * Record an episodic event.
   *
   * @param agentId - Owning agent.
   * @param runId   - Run (execution) identifier.
   * @param event   - Event name / label.
   * @param metadata - Arbitrary structured payload.
   * @param opts.traceId - OTel trace ID to associate with this entry (optional,
   *   non-breaking — callers that do not pass it produce entries invisible to queryByTrace).
   */
  record(
    agentId: string,
    runId: string,
    event: string,
    metadata?: Record<string, unknown>,
    opts?: { traceId?: string },
  ): Promise<void>;
  since(
    agentId: string,
    sinceMs: number,
    opts?: { limit?: number },
  ): Promise<EpisodicMemoryEntry[]>;
  /**
   * Retrieve all episodic entries associated with a given OTel trace ID,
   * ordered by insertion (ascending timestamp).
   *
   * @param traceId - OTel W3C trace ID (32 hex chars) or any opaque run-correlation key.
   * @param opts.limit - Maximum number of entries to return (default: unbounded).
   * @returns Entries matching traceId, oldest first.
   */
  queryByTrace(traceId: string, opts?: { limit?: number }): Promise<EpisodicMemoryEntry[]>;
  /**
   * Append an episodic event — mirrors `episodic_append`
   * (brain-protocol/docs/memory-contract-v12.md §5). Returns the created
   * event's id.
   *
   * ADDITIVE (sprint-895) — `record()` delegates to this method internally;
   * existing `record()`/`since()`/`queryByTrace()` callers are unaffected.
   *
   * @throws {MemoryValidationError} if `content` is an empty string.
   */
  append(
    agentId: string,
    sessionId: string,
    eventType: string,
    content: string | Record<string, unknown>,
    opts?: EpisodicAppendOptions,
  ): Promise<string>;
  /**
   * Query episodic events — mirrors `episodic_query`.
   *
   * @throws {MemoryValidationError} if `filter.agentId` is empty.
   */
  query(filter: EpisodicQueryFilter): Promise<EpisodicEvent[]>;
}

interface EpisodicRow {
  id: string;
  agentId: string;
  sessionId: string;
  eventType: string;
  content: string | Record<string, unknown>;
  importanceScore: number;
  artifacts?: string[];
  metadata?: Record<string, unknown>;
  traceId?: string;
  createdAt: string;
  /** Epoch ms — kept alongside createdAt for the legacy since()/queryByTrace ordering. */
  timestamp: number;
}

function episodicRowToLegacyEntry(row: EpisodicRow): EpisodicMemoryEntry {
  // A legacy record() call with no explicit metadata falls back to storing the
  // event name as `content` (string) so the append() `content` field stays
  // non-empty; that fallback must NOT resurface as `.metadata` here.
  const metadata = typeof row.content === "object" ? row.content : row.metadata;
  return {
    agentId: row.agentId,
    runId: row.sessionId,
    event: row.eventType,
    metadata,
    timestamp: row.timestamp,
    traceId: row.traceId,
  };
}

function episodicRowToEvent(row: EpisodicRow): EpisodicEvent {
  return {
    id: row.id,
    agentId: row.agentId,
    sessionId: row.sessionId,
    eventType: row.eventType,
    content: row.content,
    importanceScore: row.importanceScore,
    artifacts: row.artifacts,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export class InMemoryEpisodicMemory implements EpisodicMemoryPort {
  private events: EpisodicRow[] = [];
  private nextId = 1;

  async record(
    agentId: string,
    runId: string,
    event: string,
    metadata?: Record<string, unknown>,
    opts?: { traceId?: string },
  ): Promise<void> {
    // Legacy signature has no importanceScore/artifacts; append() defaults apply.
    await this.append(agentId, runId, event, metadata ?? event, {
      traceId: opts?.traceId,
    });
  }

  async since(
    agentId: string,
    sinceMs: number,
    opts?: { limit?: number },
  ): Promise<EpisodicMemoryEntry[]> {
    const filtered = this.events
      .filter((e) => e.agentId === agentId && e.timestamp >= sinceMs)
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(episodicRowToLegacyEntry);
    return opts?.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  async queryByTrace(traceId: string, opts?: { limit?: number }): Promise<EpisodicMemoryEntry[]> {
    // Insertion order is preserved (Array.filter is stable; events are pushed in order).
    const filtered = this.events.filter((e) => e.traceId === traceId).map(episodicRowToLegacyEntry);
    return opts?.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  async append(
    agentId: string,
    sessionId: string,
    eventType: string,
    content: string | Record<string, unknown>,
    opts?: EpisodicAppendOptions,
  ): Promise<string> {
    if (typeof content === "string" && content.trim().length === 0) {
      throw new MemoryValidationError("content must be a non-empty string or an object");
    }
    const id = `episodic-${this.nextId++}`;
    this.events.push({
      id,
      agentId,
      sessionId,
      eventType,
      content,
      importanceScore: opts?.importanceScore ?? 0.5,
      artifacts: opts?.artifacts,
      metadata: opts?.metadata,
      traceId: opts?.traceId,
      createdAt: new Date().toISOString(),
      timestamp: Date.now(),
    });
    return id;
  }

  async query(filter: EpisodicQueryFilter): Promise<EpisodicEvent[]> {
    if (filter.agentId.trim().length === 0) {
      throw new MemoryValidationError("agentId is required");
    }
    let results = this.events.filter((e) => e.agentId === filter.agentId);

    if (filter.sessionId !== undefined) {
      const sessionId = filter.sessionId;
      results = results.filter((e) => e.sessionId === sessionId);
    }
    if (filter.timerangeStart !== undefined) {
      const start = filter.timerangeStart;
      results = results.filter((e) => e.createdAt >= start);
    }
    if (filter.timerangeEnd !== undefined) {
      const end = filter.timerangeEnd;
      results = results.filter((e) => e.createdAt <= end);
    }
    if (filter.eventTypes !== undefined && filter.eventTypes.length > 0) {
      const types = filter.eventTypes;
      results = results.filter((e) => types.includes(e.eventType));
    }
    const minImportance = filter.minImportance ?? 0;
    results = results.filter((e) => e.importanceScore >= minImportance);

    const ordered = [...results].sort((a, b) => {
      if (b.importanceScore !== a.importanceScore) return b.importanceScore - a.importanceScore;
      return b.timestamp - a.timestamp;
    });
    const limit = filter.limit ?? 20;
    return ordered.slice(0, limit).map(episodicRowToEvent);
  }
}

// ─── Tier 3: Semantic memory (C4 — sprint-564) ───────────────────────────────

// Import recall types for the additive alignment (sprint-806, ADR-ECO-065).
// Kept as a type-only import to avoid circular deps (recall/ -> ports/ -> recall/).
import type { BrainRecallPort, RecallOptions, RecallResult } from "../recall/types.js";

/** @public */
export interface SemanticMemoryPort {
  /** Query shared knowledge across agents. */
  query(q: string, filters?: BrainQueryFilters): Promise<BrainEntry[]>;
  /** Archive shared knowledge. */
  archive(entry: BrainEntryInput): Promise<BrainEntry | null>;
  /**
   * Agentic recall via BrainRecallPort (ADR-ECO-065, sprint-806).
   *
   * ADDITIVE — optional method. Implementations that do not override this
   * fall back to the query() path automatically (backward-compat preserved).
   * New code should prefer recall() over query() for memory retrieval so that
   * the cache-safe <memory_context> pipeline (multi-hop, CoVe) is used.
   *
   * Default implementation delegates to brainRecall() from recall/brain-recall.ts.
   * Implementations may override to inject a custom BrainRecallPort.
   */
  recall?(query: string, opts: RecallOptions): Promise<RecallResult>;
}

// Re-export BrainRecallPort so consumers of SemanticMemoryPort can extend via
// BrainRecallPort without importing from recall/ directly.
export type { BrainRecallPort, RecallOptions, RecallResult };

export class InMemorySemanticMemory implements SemanticMemoryPort {
  private entries: BrainEntry[] = [];

  async query(q: string, filters?: BrainQueryFilters): Promise<BrainEntry[]> {
    let results = this.entries.filter((e) => e.content.toLowerCase().includes(q.toLowerCase()));
    if (filters?.category) results = results.filter((e) => e.category === filters.category);
    if (filters?.tags && filters.tags.length > 0) {
      results = results.filter((e) => e.tags?.some((t) => filters.tags?.includes(t)));
    }
    return filters?.limit ? results.slice(0, filters.limit) : results;
  }

  async archive(entry: BrainEntryInput): Promise<BrainEntry | null> {
    const created: BrainEntry = {
      id: `semantic-${this.entries.length + 1}`,
      content: entry.content,
      category: entry.category,
      tags: entry.tags,
      metadata: entry.metadata as Record<string, unknown> | undefined,
      created_at: new Date().toISOString(),
    };
    this.entries.push(created);
    return created;
  }

  /**
   * Additive recall() — routes through brainRecall() (ADR-ECO-065, sprint-806).
   * InMemory implementation has no Brain URL; delegates to brainRecall() which
   * returns EMPTY_RESULT when BRAIN_URL env var is absent (fail-soft by design).
   */
  async recall(query: string, opts: RecallOptions): Promise<RecallResult> {
    // Dynamic import avoids circular dep: brain.ts -> recall/brain-recall.ts
    // -> ports/index.ts (logger) but NOT -> ports/brain.ts. Safe at runtime.
    const { brainRecall } = await import("../recall/brain-recall.js");
    return brainRecall(query, opts);
  }
}

// ─── Tier 4: Procedural memory (C4 — sprint-564) ─────────────────────────────

/** @public */
export interface ProceduralSkill {
  name: string;
  description: string;
  source: "learning-loop" | "manual" | "shared";
  confidence: number;
  chainOfThought?: string;
}

/** @public */
export interface ProceduralMemoryPort {
  /** Resolve all skills available to an agent (learned + shared + private). */
  resolveSkills(agentId: string): Promise<ProceduralSkill[]>;
  /** Register a learned skill for an agent. */
  registerSkill(agentId: string, skill: ProceduralSkill): Promise<void>;
  /** Share a skill with other agents. */
  shareSkill(skillName: string, fromAgentId: string, toAgentIds: string[]): Promise<void>;
}

export class InMemoryProceduralMemory implements ProceduralMemoryPort {
  private skills = new Map<string, ProceduralSkill[]>();
  private shared = new Map<string, string[]>();

  async resolveSkills(agentId: string): Promise<ProceduralSkill[]> {
    const own = this.skills.get(agentId) ?? [];
    const sharedSkills: ProceduralSkill[] = [];
    for (const [fromAgent, skillNames] of this.shared) {
      const fromSkills = this.skills.get(fromAgent) ?? [];
      for (const name of skillNames) {
        const skill = fromSkills.find((s) => s.name === name);
        if (skill) sharedSkills.push({ ...skill, source: "shared" as const });
      }
    }
    return [...own, ...sharedSkills];
  }

  async registerSkill(agentId: string, skill: ProceduralSkill): Promise<void> {
    const existing = this.skills.get(agentId) ?? [];
    this.skills.set(agentId, [...existing, skill]);
  }

  async shareSkill(skillName: string, fromAgentId: string, toAgentIds: string[]): Promise<void> {
    for (const _toAgent of toAgentIds) {
      const shared = this.shared.get(fromAgentId) ?? [];
      if (!shared.includes(skillName)) {
        this.shared.set(fromAgentId, [...shared, skillName]);
      }
    }
  }
}

// ─── Claims plane (sprint-895, ADR-ECO-114) ──────────────────────────────────

/** Provenance of a claim assertion. @public */
export type ClaimSource =
  | "human_input"
  | "agent_inference"
  | "consolidation"
  | "external_ingestion";

/** Lifecycle status of a claim. @public */
export type ClaimStatus = "active" | "disputed" | "superseded" | "retracted";

/**
 * SDK-level governance scope tag (default "private" per the narrowest-scope
 * discipline, brain-protocol/docs/using-v12-memory.md §7). NOTE: the deployed
 * `claim_assert` MCP tool (memory-contract-v12.md §5) has no `scope`
 * parameter today — this field is local governance metadata carried by the
 * SDK port so an implementation can apply the discipline ahead of the wire
 * contract catching up; an HTTP-backed ClaimPort should not send it to
 * claim_assert until Brain ships that parameter.
 * @public
 */
export type MemoryScope = "private" | "shared" | "org_wide" | "cross_org";

/**
 * A verifiable, time-bounded (subject, predicate, object) triple — Brain V12
 * Claims plane (brain-protocol/docs/memory-contract-v12.md §1.4, §5 Claims).
 * @public
 */
export interface Claim {
  id: string;
  subject: string;
  predicate: string;
  object?: string;
  confidence: number;
  claimSource: ClaimSource;
  claimStatus: ClaimStatus;
  validFrom?: string;
  validUntil?: string;
  entryId?: string;
  /** The agent that asserted this claim, if provided (claim_query `agentId` filter target). */
  agentId?: string;
  createdAt: string;
  /** See `MemoryScope` doc for the deployed-vs-SDK caveat. */
  scope: MemoryScope;
}

/**
 * Options for assert() — mirrors `claim_assert`
 * (brain-protocol/docs/memory-contract-v12.md §5).
 * @public
 */
export interface ClaimAssertOptions {
  /** Provenance of the claim. Default "agent_inference" (SDK asserts on an agent's behalf). */
  claimSource?: ClaimSource;
  /** 0-1 confidence. Default 0.8 (V12 default). */
  confidence?: number;
  /** ISO-8601 — when this claim became true in the world (event_time semantics). */
  validFrom?: string;
  /** ISO-8601 — null/absent means currently valid. */
  validUntil?: string;
  /** Parent `knowledge_entries.id`; a stub entry is implied when omitted (V12 behavior). */
  entryId?: string;
  /** The asserting agent (see `Claim.agentId`). */
  agentId?: string;
  /** Narrowest scope that works. Default "private" (see `Claim.scope` doc). */
  scope?: MemoryScope;
}

/**
 * Filter for query() — mirrors `claim_query`. At least one of
 * subject/predicate/object/agentId is required. agentId-only queries
 * ("everything this agent asserted") are supported by the deployed claims
 * surface since brain-protocol #103 (memory-contract-v12.md §5 relax,
 * sprint-936 claims-filter-relax).
 * @public
 */
export interface ClaimQueryFilter {
  subject?: string;
  predicate?: string;
  object?: string;
  /** Default "active". */
  claimStatus?: ClaimStatus;
  agentId?: string;
  /** Default 20. */
  limit?: number;
}

/**
 * Claims — verifiable, time-bounded assertions you can query by
 * subject/predicate/object and reason over across time
 * (brain-protocol/docs/using-v12-memory.md §4).
 * @public
 */
export interface ClaimPort {
  /**
   * Assert a (subject, predicate, object) triple. Returns the created claim's id.
   * @throws {MemoryValidationError} if `subject` or `predicate` is empty.
   */
  assert(
    subject: string,
    predicate: string,
    object?: string,
    opts?: ClaimAssertOptions,
  ): Promise<string>;
  /**
   * Query claims. Defaults to `claimStatus: "active"`.
   * @throws {MemoryValidationError} if none of subject/predicate/object/agentId is provided.
   */
  query(filter: ClaimQueryFilter): Promise<Claim[]>;
}

export class InMemoryClaimPort implements ClaimPort {
  private claims: Claim[] = [];
  private nextId = 1;

  async assert(
    subject: string,
    predicate: string,
    object?: string,
    opts?: ClaimAssertOptions,
  ): Promise<string> {
    if (subject.trim().length === 0 || predicate.trim().length === 0) {
      throw new MemoryValidationError("subject and predicate are required");
    }
    const id = `claim-${this.nextId++}`;
    this.claims.push({
      id,
      subject,
      predicate,
      object,
      confidence: opts?.confidence ?? 0.8,
      claimSource: opts?.claimSource ?? "agent_inference",
      claimStatus: "active",
      validFrom: opts?.validFrom,
      validUntil: opts?.validUntil,
      entryId: opts?.entryId,
      agentId: opts?.agentId,
      createdAt: new Date().toISOString(),
      scope: opts?.scope ?? "private",
    });
    return id;
  }

  async query(filter: ClaimQueryFilter): Promise<Claim[]> {
    if (!filter.subject && !filter.predicate && !filter.object && !filter.agentId) {
      throw new MemoryValidationError(
        "at least one of subject, predicate, object, or agentId must be provided",
      );
    }
    const status = filter.claimStatus ?? "active";
    let results = this.claims.filter((c) => c.claimStatus === status);
    if (filter.subject !== undefined) {
      const subject = filter.subject;
      results = results.filter((c) => c.subject === subject);
    }
    if (filter.predicate !== undefined) {
      const predicate = filter.predicate;
      results = results.filter((c) => c.predicate === predicate);
    }
    if (filter.object !== undefined) {
      const object = filter.object;
      results = results.filter((c) => c.object === object);
    }
    if (filter.agentId !== undefined) {
      const agentId = filter.agentId;
      results = results.filter((c) => c.agentId === agentId);
    }
    const ordered = [...results].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const limit = filter.limit ?? 20;
    return ordered.slice(0, limit);
  }
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when the Brain API is unreachable (connection refused, DNS failure,
 * timeout on connect). Callers can retry with backoff or fall back to a local cache.
 * @public
 */
export class BrainUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrainUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Brain API returns 429 (rate limit exceeded).
 * Callers should retry after the delay indicated in the `retryAfterMs` field
 * (extracted from the Retry-After header) or use exponential backoff.
 * @public
 */
export class BrainRateLimitError extends Error {
  /** Retry-After delay in milliseconds. Derived from the HTTP Retry-After header. */
  readonly retryAfterMs: number;

  constructor(
    message: string,
    retryAfterMs: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BrainRateLimitError";
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by working/episodic/claims port methods on invalid input (e.g. an
 * empty `content`/`subject`/`predicate`, a non-positive `ttlMs`, a claim_query
 * with no subject/predicate/object). This is a caller-input error, distinct
 * from BrainUnavailableError (transport) and BrainRateLimitError (throttling).
 * @public
 */
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Campaign post-mortem + lesson types (Phase 9 — campaign orchestrator) ───

/**
 * Input for archiving a campaign post-mortem.
 * Stored under category `vauban_postmortem` with tags
 * `["postmortem", "campaign:<slug>", "outcome:<outcome>"]`.
 * @public
 */
export interface PostmortemInput {
  readonly campaign_slug: string;
  readonly outcome: "success" | "partial" | "failure";
  readonly metrics: Readonly<Record<string, number>>;
  readonly what_worked: readonly string[];
  readonly what_failed: readonly string[];
  readonly lessons: readonly string[];
}

/**
 * Input for archiving a reusable lesson learned.
 * Stored under category `vauban_lesson` with tags
 * `["lesson", ...applies_to]`.
 * @public
 */
export interface LessonInput {
  readonly title: string;
  readonly context: string;
  readonly insight: string;
  readonly applies_to: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

// ─── Full BrainPort (4 tiers, additive non-breaking) ─────────────────────────

/** @public */
export interface BrainPort {
  archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null>;
  queryKnowledge?(query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]>;

  /**
   * Archive a campaign post-mortem. Optional — implementations that do not
   * override this fall back to the default in `HttpBrainAdapter`.
   */
  archivePostmortem?(input: PostmortemInput): Promise<void>;

  /**
   * Archive a reusable lesson learned. Optional — same fallback as above.
   */
  archiveLesson?(input: LessonInput): Promise<void>;

  working?: WorkingMemoryPort;
  episodic?: EpisodicMemoryPort;
  semantic?: SemanticMemoryPort;
  procedural?: ProceduralMemoryPort;
  claims?: ClaimPort;
}

// ─── OTel-traced wrapper ──────────────────────────────────────────────────────

import type { Span } from "@opentelemetry/api";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const PORT_TRACER = trace.getTracer("vauban-agent-sdk.ports", "0.1.0");

/**
 * Wrap any BrainPort implementation with OTel spans.
 * archiveKnowledge and queryKnowledge calls each get a span with the category
 * and content preview. Gracefully degrades to noop spans when no OTel SDK
 * is installed.
 *
 * INSTRUMENTS two methods and PRESERVES everything else, including members
 * this module has never heard of: a `MultiBrainPort`
 * (`adapters/multi-brain.ts`) keeps `queryAcrossBrains` / `brains` /
 * `defaultBrain` through the wrapper, and so will whatever a future subtype
 * adds. See the implementation note for why that required a Proxy.
 *
 * Usage:
 *   const raw: BrainPort = buildHttpBrain(...);
 *   const traced = createTracedBrainPort(raw);
 *   await traced.archiveKnowledge({ content: "..." }) // emits "brain.archiveKnowledge" span
 */
export function createTracedBrainPort(impl: BrainPort): BrainPort {
  // `queryKnowledge` is OPTIONAL on `BrainPort`, and an absent one must stay
  // absent through the wrapper.
  //
  // Until 2026-08-29 this method was defined unconditionally and opened with
  // `if (!impl.queryKnowledge) return []`. Wrapping an implementation that has
  // no query surface therefore produced a port where `port.queryKnowledge` is
  // truthy and answers `[]` forever: a caller feature-detecting the capability
  // is told it exists, and then told there is nothing to find. That is absence
  // rendered as a fact, the forbidden motif ADR-ECO-149 names, sitting in the
  // module that defines the contract.
  const tracedArchiveKnowledge = async (entry: BrainEntryInput): Promise<BrainEntry | null> =>
    PORT_TRACER.startActiveSpan(
      "brain.archiveKnowledge",
      {
        attributes: {
          "brain.entry.category": entry.category ?? "unknown",
          "brain.entry.content_preview": entry.content.slice(0, 200),
          "brain.entry.tags": entry.tags?.join(",") ?? "",
          "vauban.port.name": "brain",
        },
      },
      async (span: Span) => {
        try {
          const result = await impl.archiveKnowledge(entry);
          if (result) {
            span.setAttribute("brain.entry.id", result.id);
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          if (err instanceof Error) span.recordException(err);
          throw err;
        } finally {
          span.end();
        }
      },
    );

  // Keyed by name so the Proxy traps below can answer get/has/ownKeys from one
  // place, and so an absent optional method is simply an absent key.
  const overrides = new Map<string | symbol, unknown>([
    ["archiveKnowledge", tracedArchiveKnowledge],
  ]);

  if (impl.queryKnowledge) {
    const qk = impl.queryKnowledge.bind(impl);
    overrides.set(
      "queryKnowledge",
      async (query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]> =>
        PORT_TRACER.startActiveSpan(
          "brain.queryKnowledge",
          {
            attributes: {
              "brain.query.preview": query.slice(0, 200),
              "brain.query.category": filters?.category ?? "none",
              "brain.query.limit": filters?.limit ?? -1,
              "vauban.port.name": "brain",
            },
          },
          async (span: Span) => {
            try {
              const result = await qk(query, filters);
              span.setAttribute("brain.query.result_count", result.length);
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              span.setStatus({ code: SpanStatusCode.ERROR, message });
              if (err instanceof Error) span.recordException(err);
              throw err;
            } finally {
              span.end();
            }
          },
        ),
    );
  }

  // ── WHY A PROXY, and not the object literal this used to be ───────────────
  //
  // Until 2026-08-29 this returned an object literal listing the members it
  // knew about. Anything else was dropped, silently, with the right TYPE:
  // wrapping a `MultiBrainPort` produced a port whose `queryAcrossBrains` and
  // `brains` were `undefined` (mesure du 2026-08-29 sur un port a deux
  // delegues : `mb.queryAcrossBrains` function / `traced.queryAcrossBrains`
  // undefined). `queryAcrossBrains` is the ONLY channel that reports which
  // Brains were unreachable, so instrumenting a port for observability was
  // deleting the one thing that tells a caller its answer is incomplete.
  //
  // The defect is structural, not a missed line: an enumerating copy is wrong
  // again on every future member of `BrainPort` and on every subtype. Only a
  // forwarding wrapper cannot regress that way. The two alternatives were
  // measured, not assumed (probe run 2026-08-29):
  //
  //   - SPREAD `{ ...impl, ...overrides }` copies own enumerable properties
  //     only. On `TestBrainPort` (testing/test-brain-port.ts, a class) it
  //     yields `archiveKnowledge: undefined` -- prototype methods are not own
  //     properties -- while `working` survives as an instance field. It would
  //     turn a class-based port into one missing its REQUIRED method, and
  //     Forge's `PostgresBrainAdapter` is such a class.
  //   - `Object.create(impl)` keeps the prototype chain but calls every
  //     inherited method with `this` set to the wrapper, which throws
  //     `TypeError: Cannot read private member #x from an object whose class
  //     did not declare it` on any impl holding private state.
  //
  // The Proxy's costs, stated rather than waved away: one trap per property
  // access, which is unmeasurable against the HTTP round trip every real
  // method here performs; and `console.log` of a proxy, which Node's
  // util.inspect renders as the target by default (`showProxy` is off).
  //
  // The target is an EMPTY object, not `impl`, and that is load-bearing rather
  // than stylistic. A Proxy must not contradict its target's own non-writable,
  // non-configurable properties: over a frozen `impl`, returning the
  // instrumented `archiveKnowledge` throws `TypeError: 'get' on proxy: property
  // 'archiveKnowledge' is a read-only and non-configurable data property [...]
  // but the proxy did not return its actual value` (measured 2026-08-29, by the
  // test that pins the frozen case). The only escapes were to refuse frozen
  // impls or to hand back the UNINSTRUMENTED method, and the second is a
  // wrapper lying about what it traces. An empty extensible target carries no
  // invariant to violate, so every trap below answers from `impl` and the
  // overrides alone.
  // Typed as the port it stands in for: every read of it is intercepted by the
  // traps below, none of which ever consults it.
  const shell = {} as BrainPort;

  // Methods are bound to `impl`, never to the proxy, and memoised per source
  // function: binding to the proxy would re-enter these traps on every internal
  // `this.x` and reintroduce the private-field failure above, and an unmemoised
  // bind would make `port.m !== port.m`.
  const boundCache = new WeakMap<object, unknown>();

  return new Proxy(shell, {
    get(_shell, prop) {
      if (overrides.has(prop)) return overrides.get(prop);
      const value = Reflect.get(impl, prop, impl);
      if (typeof value !== "function") return value;
      const cached = boundCache.get(value as unknown as object);
      if (cached !== undefined) return cached;
      const bound = value.bind(impl);
      boundCache.set(value as unknown as object, bound);
      return bound;
    },
    has(_shell, prop) {
      return overrides.has(prop) || Reflect.has(impl, prop);
    },
    getPrototypeOf() {
      // So `instanceof` still recognises a class-based impl through the wrapper.
      return Reflect.getPrototypeOf(impl);
    },
    getOwnPropertyDescriptor(_shell, prop) {
      // Own-property visibility must agree with `get`, or a caller that spreads
      // or `Object.keys`-walks the traced port gets the UNINSTRUMENTED method
      // back -- the same enumerating-copy trap, one level up. `configurable` is
      // forced true because the empty target has no such property, and a Proxy
      // may not report a non-configurable one that its target lacks.
      if (overrides.has(prop)) {
        return { value: overrides.get(prop), writable: true, enumerable: true, configurable: true };
      }
      const d = Reflect.getOwnPropertyDescriptor(impl, prop);
      return d ? { ...d, configurable: true } : undefined;
    },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(impl), ...overrides.keys()])];
    },
    set(_shell, prop, value) {
      // Writes land on `impl`. Left to the empty target they would vanish from
      // every read, since no trap above ever consults it.
      return Reflect.set(impl, prop, value);
    },
    deleteProperty(_shell, prop) {
      return Reflect.deleteProperty(impl, prop);
    },
  });
}
