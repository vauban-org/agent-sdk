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

import type { OODAContext } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single chunk returned from a Brain retrieval. `entry_id` is the only
 * field consumed by certificate assembly; the rest is forwarded to the
 * wrapped orient phase.
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
 */
export interface BrainCallResult<T> {
  readonly result: T;
  readonly mcp_call_hash: string;
  readonly retrieval_proof_hash: string;
}

/**
 * Configuration for the wrapper.
 *
 * `enabled: false` short-circuits to an empty context — orient still
 * receives `OrientInputWithBrain` but with `brainContext: []`.
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
   */
  readonly fetchBrainContext?: (
    query: string,
    topK: number,
  ) => Promise<BrainCallResult<BrainChunk[]>>;
  /**
   * Optional deterministic replay fixture. When `ctx.isReplay === true`,
   * the wrapper returns these chunks instead of calling Brain.
   */
  readonly replayChunks?: BrainChunk[];
}

/**
 * The augmented input the wrapped orient phase receives. `raw` is the
 * original observe output; `brainContext` is the filtered chunk list;
 * `brainContextRefs` is the ordered, deduped list of entry IDs that
 * `assembleRunCertificate` will lift onto the proof certificate.
 */
export interface OrientInputWithBrain<TObs> {
  readonly raw: TObs;
  readonly brainContext: BrainChunk[];
  readonly brainContextRefs: string[];
}

// ─── Errors ───────────────────────────────────────────────────────────────────

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
 */
export function withBrainContext<TObs, TOrient>(
  options: BrainContextOptions<TObs>,
  orientFn: (
    input: OrientInputWithBrain<TObs>,
    ctx: OODAContext,
  ) => Promise<TOrient>,
): (input: TObs, ctx: OODAContext) => Promise<TOrient> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  return async (input, ctx) => {
    // Fast path: disabled → orient receives an empty context, no step row.
    if (!options.enabled) {
      return orientFn(
        { raw: input, brainContext: [], brainContextRefs: [] },
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

    try {
      if (ctx.isReplay) {
        chunks = filterAndRank(
          options.replayChunks ?? [],
          topK,
          minSimilarity,
        );
      } else {
        if (!options.fetchBrainContext) {
          throw new BrainSkillNotConfiguredError();
        }
        const call = await options.fetchBrainContext(query, topK);
        mcpCallHash = call.mcp_call_hash;
        retrievalProofHash = call.retrieval_proof_hash;
        chunks = filterAndRank(call.result, topK, minSimilarity);
      }
    } catch (err) {
      await ctx.errorStep(
        stepId,
        err instanceof Error ? err : new Error(String(err)),
      );
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
    });

    return orientFn({ raw: input, brainContext: chunks, brainContextRefs }, ctx);
  };
}
