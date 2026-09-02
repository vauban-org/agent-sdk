/**
 * src/constitution/signal.ts
 *
 * Publishes soft constitutional scorer results to Brain episodic memory.
 * Decouples the scoring pipeline from Brain I/O — purely an adapter.
 *
 * @module constitution/signal
 */

import type { EpisodicAppendOptions, EpisodicMemoryPort } from "../ports/brain.js";
import type { AxiomId, CycleSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal Brain port required by publishSignal.
 * Requires only the episodic tier (Tier 2).
 * @public
 */
export interface SignalBrainPort {
  episodic?: EpisodicMemoryPort;
}

// ---------------------------------------------------------------------------
// publishEpisodicEvent — the single episodic-write pattern (sprint-895)
// ---------------------------------------------------------------------------

/**
 * A material agent event to append to Episodic Memory.
 *
 * `agentId` is the source_agent_id carried on the wire (`episodic_append`
 * always sends `sourceAgentId: agentId`) — it triggers the EU AI Act Art.19
 * 180-day retention floor downstream, so an EM event is always attributable.
 * Callers MUST keep `content`/`metadata` free of raw PII (mask first).
 * @public
 */
export interface EpisodicEventInput {
  /** Source agent (the accountable identity for this event). */
  readonly agentId: string;
  /** Session/run identifier (V12 `sessionId`). */
  readonly sessionId: string;
  /** Event kind — e.g. "decision" | "observation" | "error". */
  readonly eventType: string;
  /** PII-free event body — string or structured object. */
  readonly content: string | Record<string, unknown>;
  /** 0-1 salience. Default 0.5 (episodic_append default). */
  readonly importanceScore?: number;
  /** Additional PII-free structured payload. */
  readonly metadata?: Record<string, unknown>;
  /** OTel trace correlation key. */
  readonly traceId?: string;
}

/**
 * Append one material event to Brain Episodic Memory via `episodic.append`
 * (V12 `episodic_append`). Feature-detects the episodic plane: no-ops
 * silently (returns `undefined`) when it is absent, so semantic-only hosts
 * are unaffected.
 *
 * This is the SINGLE episodic-write pattern for the SDK — the OODA cycle loop
 * (observe/decide/error events) routes through here rather than duplicating
 * the feature-detect + append at each call site.
 *
 * @returns the created event id, or `undefined` when no episodic plane exists.
 * @public
 */
export async function publishEpisodicEvent(
  brainPort: SignalBrainPort,
  input: EpisodicEventInput,
): Promise<string | undefined> {
  if (!brainPort.episodic) return undefined;

  const opts: EpisodicAppendOptions = {
    ...(input.importanceScore !== undefined ? { importanceScore: input.importanceScore } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  };

  return brainPort.episodic.append(
    input.agentId,
    input.sessionId,
    input.eventType,
    input.content,
    opts,
  );
}

// ---------------------------------------------------------------------------
// publishSignal
// ---------------------------------------------------------------------------

/**
 * Publish a constitutional soft-score signal to Brain episodic memory.
 *
 * Tags: ["constitution_signal", axiomId]
 *
 * @param brainPort  - Host-injected BrainPort. If `episodic` is absent, no-ops silently.
 * @param cycle      - The cycle that was scored.
 * @param axiomId    - The axiom that produced the score.
 * @param score      - Normalised score in [0, 1].
 * @param rationale  - Human-readable scoring rationale for audit.
 * @public
 */
export async function publishSignal(
  brainPort: SignalBrainPort,
  cycle: CycleSnapshot,
  axiomId: AxiomId,
  score: number,
  rationale: string,
): Promise<void> {
  if (!brainPort.episodic) return;

  const event = "constitution_signal";
  const metadata: Record<string, unknown> = {
    axiom: axiomId,
    score,
    rationale,
    runId: cycle.runId,
    rootHash: cycle.rootHash,
    tags: ["constitution_signal", axiomId],
    budgetUsdMax: cycle.budgetUsdMax,
    budgetUsdSpent: cycle.budgetUsdSpent,
  };

  if (cycle.parentRunId !== undefined) {
    metadata.parentRunId = cycle.parentRunId;
  }

  if (cycle.scope_id !== undefined) {
    metadata.scope_id = cycle.scope_id;
  }

  await brainPort.episodic.record(
    // agentId: use runId as the owning agent identifier for constitution signals
    `constitution:${axiomId}`,
    cycle.runId,
    event,
    metadata,
  );
}

// ---------------------------------------------------------------------------
// publishAllSignals — convenience for scoring all axioms in one call
// ---------------------------------------------------------------------------

/** @public */
export interface AxiomScoreEntry {
  axiomId: AxiomId;
  score: number;
  rationale: string;
}

/**
 * Publish all axiom scores for a single cycle to Brain episodic.
 * Fires all records in parallel; individual failures are re-thrown as an
 * AggregateError to avoid silent drops.
 * @public
 */
export async function publishAllSignals(
  brainPort: SignalBrainPort,
  cycle: CycleSnapshot,
  scores: AxiomScoreEntry[],
): Promise<void> {
  const results = await Promise.allSettled(
    scores.map(({ axiomId, score, rationale }) =>
      publishSignal(brainPort, cycle, axiomId, score, rationale),
    ),
  );

  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason as Error);

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `publishAllSignals: ${failures.length} Brain episodic write(s) failed`,
    );
  }
}
