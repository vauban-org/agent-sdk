/**
 * Brain context auto-injection for the OODA ORIENT phase — sprint-525:quick-4.
 *
 * D1+D2 systemic fix: instead of every OODA agent calling Brain manually
 * during ORIENT, this primitive wraps the orient phase function so that:
 *
 *   1. A Brain query is built from the observe input (`options.query(input)`).
 *   2. The `query_knowledge` skill (or an injected `fetchBrainContext`) is
 *      called once, returning top-K chunks above `minSimilarity`.
 *   3. The chunks + their entry IDs are injected into the orient input as
 *      `OrientInputWithBrain<TObs>` — orient code stays decoupled from
 *      Brain MCP wiring.
 *   4. `mcp_call_hash` + `retrieval_proof_hash` are emitted via the OODA
 *      context's step-recording side-effect (a retrieval `run_step` row),
 *      so `assembleRunCertificate` populates `brain_context_refs`
 *      automatically — no per-agent boilerplate.
 *
 * Replay safety: when `ctx.isReplay === true`, the wrapper consults the
 * injected `replayChunks` (if provided) and emits no MCP call. This keeps
 * deterministic re-execution stable.
 *
 * @public
 */

import type { BrainPort, EpisodicEvent, WorkingMemorySlot } from "../../ports/brain.js";
import { type RecallOptions, brainRecall, renderMemoryContext } from "../../recall/index.js";
import type { OODAContext } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single chunk returned from a Brain retrieval. `entry_id` is the only
 * field consumed by certificate assembly; the rest is forwarded to the
 * wrapped orient phase.
 * @public
 */
export interface BrainChunk {
  readonly entry_id: string;
  readonly content: string;
  readonly similarity: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of a Brain MCP call wrapped by `callBrainTool` (server-side).
 * Re-exported in this module for SDK consumers that build their own
 * `fetchBrainContext` impl.
 * @public
 */
export interface BrainCallResult<T> {
  readonly result: T;
  readonly mcp_call_hash: string;
  readonly retrieval_proof_hash: string;
}

/**
 * Returned by the circuit breaker when Brain is unreachable (open circuit).
 * All downstream decisions MUST carry `[UNGROUNDED: brain]` markers.
 * @public
 */
export interface DegradedResponse {
  readonly status: "degraded";
  readonly fallback: "UNGROUNDED";
  readonly reason: string;
  readonly stale_since: string;
}

/**
 * Discriminator: narrow a fetch result to DegradedResponse or BrainCallResult.
 * @public
 */
export function isDegradedResponse(r: unknown): r is DegradedResponse {
  return (
    typeof r === "object" &&
    r !== null &&
    "status" in r &&
    (r as DegradedResponse).status === "degraded"
  );
}

/**
 * Configuration for the wrapper.
 *
 * `enabled: false` short-circuits to an empty context — orient still
 * receives `OrientInputWithBrain` but with `brainContext: []`.
 * @public
 */
export interface BrainContextOptions<TInput> {
  readonly enabled: boolean;
  /** Build the Brain query string from the observe phase output. */
  readonly query: (input: TInput) => string;
  /** Default 5. Bounded by the BrainPort `query_knowledge` page size. */
  readonly topK?: number;
  /** Default 0.7. Chunks below this similarity are filtered out. */
  readonly minSimilarity?: number;
  /**
   * Host-injected Brain MCP fetcher. When omitted and `enabled === true`,
   * the wrapper throws — encouraging callers to wire a `BrainPort`-backed
   * adapter at boot time. The fetcher must:
   *   - Throw `BrainSkillNotConfiguredError` when BRAIN_MCP_URL is unset.
   *   - Return `BrainCallResult` with the two hashes computed via
   *     JCS-canonicalized SHA-256 (RFC 8785).
   *
   * BACKWARD-COMPAT: when absent, the built-in `brainRecall` default is used
   * ONLY when `builtinRecall: true` is set (or BRAIN_AGENTIC_RECALL=true env).
   * Agents that do not set either flag keep the existing throw behaviour.
   */
  readonly fetchBrainContext?: (
    query: string,
    topK: number,
  ) => Promise<BrainCallResult<BrainChunk[]> | DegradedResponse>;
  /**
   * Optional deterministic replay fixture. When `ctx.isReplay === true`,
   * the wrapper returns these chunks instead of calling Brain.
   */
  readonly replayChunks?: BrainChunk[];
  /**
   * When `true` and `fetchBrainContext` is absent, activate the built-in
   * `brainRecall` default fetcher (tier=auto, complexity-auto).
   * Requires BRAIN_URL env var. Backward-compat: defaults to `false`.
   * Alternatively set BRAIN_AGENTIC_RECALL=true env to enable globally.
   * (ADR-ECO-065, sprint-805 Task 2)
   */
  readonly builtinRecall?: boolean;

  /**
   * Optional BrainPort exposing the Working Memory (`working`) + Episodic
   * Memory (`episodic`) planes. When present, `withBrainContext` ALSO loads
   * the run goal slot (WM) and a recent episodic window (EM) at cycle start
   * and folds them into `OrientInputWithBrain` ALONGSIDE the semantic recall
   * chunks. Each plane is feature-detected INDEPENDENTLY — a port exposing
   * only `working` (or only `episodic`, or neither) never throws. Semantic-only
   * hosts that omit this field are unaffected (the plane fields stay absent).
   * (sprint-895, ADR-ECO-114)
   */
  readonly memory?: Pick<BrainPort, "working" | "episodic">;

  /**
   * WM slot key holding the run goal. Default "goal". WM is private by
   * construction (the port has no scope param) per
   * brain-protocol/docs/using-v12-memory.md §1.
   */
  readonly goalSlotKey?: string;

  /** Recent episodic events to load into the window. Default 10. */
  readonly episodicWindowSize?: number;
}

/**
 * The augmented input the wrapped orient phase receives. `raw` is the
 * original observe output; `brainContext` is the filtered chunk list;
 * `brainContextRefs` is the ordered, deduped list of entry IDs that
 * `assembleRunCertificate` will lift onto the proof certificate.
 * @public
 */
export interface OrientInputWithBrain<TObs> {
  readonly raw: TObs;
  readonly brainContext: BrainChunk[];
  readonly brainContextRefs: string[];
  /**
   * The run goal slot loaded from Working Memory at cycle start. Present only
   * when `options.memory` was provided; `null` when the `working` plane is
   * absent or the slot does not exist. (sprint-895, ADR-ECO-114)
   */
  readonly workingMemoryGoal?: WorkingMemorySlot | null;
  /**
   * A recent window of Episodic Memory events for this agent/run, loaded at
   * cycle start. Present only when `options.memory` was provided; `[]` when the
   * `episodic` plane is absent. (sprint-895, ADR-ECO-114)
   */
  readonly episodicWindow?: EpisodicEvent[];
  /**
   * WM goal + EM window + semantic chunks folded into a single deterministic
   * `<memory_context>` string. Present only when `options.memory` was provided.
   * (sprint-895, ADR-ECO-114)
   */
  readonly renderedMemoryContext?: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** @public */
export class BrainSkillNotConfiguredError extends Error {
  constructor() {
    super(
      "Brain skill requires BRAIN_MCP_URL env var. " +
        "See https://command.vauban.tech/docs/sdk/brain-config",
    );
    this.name = "BrainSkillNotConfiguredError";
  }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SIMILARITY = 0.7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Filter chunks by `minSimilarity`, sort by descending similarity, then
 * truncate to `topK`. Pure — no side-effects.
 */
function filterAndRank(
  chunks: readonly BrainChunk[],
  topK: number,
  minSimilarity: number,
): BrainChunk[] {
  return chunks
    .filter((c) => c.similarity >= minSimilarity)
    .slice()
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Deduplicate entry IDs while preserving first-seen order.
 */
function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ─── WM + EM plane loading (sprint-895, ADR-ECO-114) ─────────────────────────

const DEFAULT_GOAL_SLOT_KEY = "goal";
const DEFAULT_EPISODIC_WINDOW = 10;

interface PlaneContext {
  readonly workingMemoryGoal: WorkingMemorySlot | null;
  readonly episodicWindow: EpisodicEvent[];
}

/** Serialise a WM/EM content value to a CDATA-safe string. */
function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Escape the only CDATA-reserved sequence, mirroring renderMemoryContext. */
function cdata(text: string): string {
  return text.replace(/]]>/g, "]]]]><![CDATA[>");
}

/** Escape a value for use inside an XML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Load the WM goal slot + a recent EM window for this cycle. Each plane is
 * feature-detected independently and NEVER throws — a plane failure degrades
 * to an empty result and is logged, so the orient phase always proceeds.
 * Returns `null` when `options.memory` is absent (semantic-only host).
 */
async function loadPlaneContext<TObs>(
  options: BrainContextOptions<TObs>,
  ctx: OODAContext,
): Promise<PlaneContext | null> {
  if (!options.memory) return null;

  let workingMemoryGoal: WorkingMemorySlot | null = null;
  let episodicWindow: EpisodicEvent[] = [];

  if (options.memory.working) {
    const goalKey = options.goalSlotKey ?? DEFAULT_GOAL_SLOT_KEY;
    try {
      const slots = await options.memory.working.list(ctx.runId);
      workingMemoryGoal = slots.find((s) => s.slotId === goalKey) ?? null;
    } catch (err) {
      ctx.logger.warn(
        { runId: ctx.runId, err: err instanceof Error ? err.message : String(err) },
        "brain-context.wm_goal_load_failed",
      );
    }
  }

  if (options.memory.episodic) {
    try {
      episodicWindow = await options.memory.episodic.query({
        agentId: ctx.agentId,
        sessionId: ctx.runId,
        limit: options.episodicWindowSize ?? DEFAULT_EPISODIC_WINDOW,
      });
    } catch (err) {
      ctx.logger.warn(
        { runId: ctx.runId, err: err instanceof Error ? err.message : String(err) },
        "brain-context.em_window_load_failed",
      );
    }
  }

  return { workingMemoryGoal, episodicWindow };
}

/**
 * Fold the WM goal + EM window + semantic chunks into a single deterministic
 * `<memory_context>` block with three labelled sub-sections. Chunks are
 * assumed pre-filtered/ranked; EM events preserve their query order.
 */
function foldMemoryContext(
  goal: WorkingMemorySlot | null,
  episodic: readonly EpisodicEvent[],
  chunks: readonly BrainChunk[],
): string {
  const lines: string[] = ["<memory_context>", "<working_memory>"];
  if (goal) {
    lines.push(
      `<goal slot="${escapeAttr(goal.slotId)}"><![CDATA[${cdata(stringifyContent(goal.content))}]]></goal>`,
    );
  }
  lines.push("</working_memory>", "<episodic_window>");
  for (const ev of episodic) {
    lines.push(
      `<event type="${escapeAttr(ev.eventType)}" at="${escapeAttr(ev.createdAt)}"><![CDATA[${cdata(
        stringifyContent(ev.content),
      )}]]></event>`,
    );
  }
  lines.push("</episodic_window>", "<semantic_recall>");
  for (const c of chunks) {
    lines.push(`<chunk id="${escapeAttr(c.entry_id)}"><![CDATA[${cdata(c.content)}]]></chunk>`);
  }
  lines.push("</semantic_recall>", "</memory_context>");
  return lines.join("\n");
}

/**
 * Build the additive OrientInput plane fields when `options.memory` is set;
 * returns an empty object otherwise so semantic-only hosts receive the exact
 * `{ raw, brainContext, brainContextRefs }` shape unchanged.
 */
function planeFields<TObs>(
  plane: PlaneContext | null,
  chunks: readonly BrainChunk[],
): Partial<OrientInputWithBrain<TObs>> {
  if (!plane) return {};
  return {
    workingMemoryGoal: plane.workingMemoryGoal,
    episodicWindow: plane.episodicWindow,
    renderedMemoryContext: foldMemoryContext(plane.workingMemoryGoal, plane.episodicWindow, chunks),
  };
}

// ─── Built-in recall fetcher (ADR-ECO-065, sprint-805 Task 2) ────────────────

/**
 * Build the default `fetchBrainContext` backed by `brainRecall()`.
 *
 * Activated when `options.builtinRecall === true` OR env var
 * `BRAIN_AGENTIC_RECALL=true`, and `fetchBrainContext` is absent.
 *
 * Maps RecallChunk→BrainChunk:
 *   RecallChunk.id   → BrainChunk.entry_id
 *   RecallChunk.content → BrainChunk.content
 *   best score (cross_encoder ?? hybrid ?? similarity ?? 0) → BrainChunk.similarity
 *   metadata fields  → BrainChunk.metadata
 *
 * Returns DegradedResponse on degraded path (brainRecall never throws).
 * Cache-safety: RecallResult is never placed in a cacheable prefix; the caller
 * (withBrainContext) places it in the dynamic brainContext zone only.
 */
function buildBuiltinRecallFetcher(
  topK: number,
): (
  query: string,
  resolvedTopK: number,
) => Promise<BrainCallResult<BrainChunk[]> | DegradedResponse> {
  return async (
    query: string,
    resolvedTopK: number,
  ): Promise<BrainCallResult<BrainChunk[]> | DegradedResponse> => {
    const opts: RecallOptions = {
      tier: "auto",
      mode: "chunks",
      topK: resolvedTopK || topK,
    };
    const result = await brainRecall(query, opts);

    if (result.strategy_used === "degraded") {
      return {
        status: "degraded",
        fallback: "UNGROUNDED",
        reason: "brainRecall returned degraded (BRAIN_URL unavailable or timeout)",
        stale_since: new Date().toISOString(),
      } satisfies DegradedResponse;
    }

    const sdkChunks: BrainChunk[] = result.chunks.map((c) => ({
      entry_id: c.id,
      content: c.content,
      similarity: c.cross_encoder_score ?? c.hybrid_score ?? c.similarity ?? 0,
      metadata: {
        category: c.category,
        tags: c.tags,
        created_at: c.created_at,
        brain_id: c.brain_id,
        brain_slug: c.brain_slug,
        strategy_used: result.strategy_used,
        hops_used: result.hops_used,
      },
    }));

    // Stable content hash for the step-recording audit trail.
    // Phase 0 placeholder — not a VPSF proof hash.
    const canonical = JSON.stringify({
      strategy: result.strategy_used,
      hops: result.hops_used,
      refs: result.refs,
    });
    // Simple deterministic hash using renderMemoryContext as a canonical string
    // (avoids adding a crypto dependency here; the actual hash for proof chains
    // is managed by the OODA step-recording layer).
    const hashInput = renderMemoryContext(result.chunks);
    let h = 5381;
    for (let i = 0; i < hashInput.length; i++) {
      h = ((h << 5) + h) ^ hashInput.charCodeAt(i);
      h = h >>> 0;
    }
    const hash = `builtin-recall:${h.toString(16).padStart(8, "0")}:${canonical.length}`;

    return {
      result: sdkChunks,
      mcp_call_hash: hash,
      retrieval_proof_hash: hash,
    } satisfies BrainCallResult<BrainChunk[]>;
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Wraps an orient phase function to auto-inject Brain context.
 *
 * The wrapped function:
 *   1. Inserts a `retrieval` step (pending).
 *   2. Calls `fetchBrainContext` (unless disabled or replaying).
 *   3. Filters/sorts/truncates chunks per config.
 *   4. Completes the retrieval step with `mcp_call_hash` + entry IDs in
 *      the payload — `assembleRunCertificate` lifts entry IDs onto the
 *      certificate's `brain_context_refs`.
 *   5. Invokes the inner orient with `OrientInputWithBrain<TObs>`.
 *
 * Strict typing: the inner orient remains parametric in `TObs`/`TOrient`,
 * so existing OODA `PhaseDef<TObs, TOrient>` consumers can adopt this
 * wrapper without rewriting types — they swap the `fn` field for the
 * wrapper's return value.
 * @public
 */
export function withBrainContext<TObs, TOrient>(
  options: BrainContextOptions<TObs>,
  orientFn: (input: OrientInputWithBrain<TObs>, ctx: OODAContext) => Promise<TOrient>,
): (input: TObs, ctx: OODAContext) => Promise<TOrient> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  return async (input, ctx) => {
    // Fast path: disabled → orient receives an empty semantic context, no step
    // row. WM/EM planes still load at cycle start when `options.memory` is set
    // (semantic recall being off is orthogonal to the WM/EM planes).
    if (!options.enabled) {
      const plane = await loadPlaneContext(options, ctx);
      return orientFn(
        {
          raw: input,
          brainContext: [],
          brainContextRefs: [],
          ...planeFields<TObs>(plane, []),
        },
        ctx,
      );
    }

    const query = options.query(input);
    const { stepId } = await ctx.insertStep({
      type: "retrieval",
      phase: "orient.brain-context",
      payload: { query, topK, minSimilarity },
    });

    let chunks: BrainChunk[];
    let mcpCallHash: string | null = null;
    let retrievalProofHash: string | null = null;
    let degradedResponse: DegradedResponse | null = null;

    try {
      if (ctx.isReplay) {
        chunks = filterAndRank(options.replayChunks ?? [], topK, minSimilarity);
      } else {
        // Resolve the fetcher: explicit > built-in default > throw.
        const builtinEnabled =
          options.builtinRecall === true || process.env.BRAIN_AGENTIC_RECALL === "true";
        const fetcher =
          options.fetchBrainContext ?? (builtinEnabled ? buildBuiltinRecallFetcher(topK) : null);
        if (!fetcher) {
          throw new BrainSkillNotConfiguredError();
        }
        const call = await fetcher(query, topK);

        // Circuit breaker: Brain is down → return empty context instead of crashing
        if (isDegradedResponse(call)) {
          degradedResponse = call;
          chunks = [];
        } else {
          mcpCallHash = call.mcp_call_hash;
          retrievalProofHash = call.retrieval_proof_hash;
          chunks = filterAndRank(call.result, topK, minSimilarity);
        }
      }
    } catch (err) {
      await ctx.errorStep(stepId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    const brainContextRefs = dedupePreserveOrder(chunks.map((c) => c.entry_id));

    // Complete the retrieval step. The OODA host owns mcp_call_hash
    // column writing; the SDK contract is to surface it via payload so
    // the host adapter (insertStepImpl/completeStepImpl) can lift it onto
    // the run_step row when persisting.
    await ctx.completeStep(stepId, {
      query,
      brain_entry_ids: brainContextRefs,
      mcp_call_hash: mcpCallHash,
      retrieval_proof_hash: retrievalProofHash,
      chunk_count: chunks.length,
      ...(degradedResponse ? { degraded: true, fallback: degradedResponse.fallback } : {}),
    });

    // Load WM goal + EM window at cycle start and fold them into the rendered
    // context ALONGSIDE the semantic chunks. Each plane is feature-detected
    // independently; absence never throws (semantic-only hosts unaffected).
    const plane = await loadPlaneContext(options, ctx);

    return orientFn(
      {
        raw: input,
        brainContext: chunks,
        brainContextRefs,
        ...planeFields<TObs>(plane, chunks),
      },
      ctx,
    );
  };
}
