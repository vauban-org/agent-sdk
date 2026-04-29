/**
 * AgentRunTracker — per-run token/cost accounting for agent loops.
 *
 * Lifecycle:
 *   1. start(input)      → INSERT agent_run row with status='running', returns UUID.
 *   2. recordStep(uuid)  → UPDATE increments input/output/tool_calls/cost_usd counters.
 *   3. finish(uuid)      → UPDATE sets finished_at, status, stop_reason.
 *
 * Contract: agent_version is required at start().
 * Cost is NUMERIC(10,6) USD (Postgres returns as string from pg driver — we
 * normalise to string at the boundary).
 *
 * Persistence layer only — no side effects beyond DB. OTel spans are emitted
 * by the caller (loop) with `gen_ai.usage.*` attributes.
 */

// ─── DbClient interface (inlined to avoid CC dep) ────────────────────────────

/**
 * Minimal injectable Postgres interface.
 * Compatible with `pg.Pool`, `pg.Client`, and test mocks.
 */
export interface DbClient {
  query<T extends object>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface AgentRunStartInput {
  agentId: string;
  agentVersion: string;
  /** Caller-generated run id (matches the loop's runId / trace). */
  runId: string;
  model: string;
  provider: string;
  tenantId?: string;
  /** OTel trace id for replay linkage. */
  traceId?: string;
}

export interface AgentRunStepDelta {
  inputTokens: number;
  outputTokens: number;
  toolCalls?: number;
  /**
   * USD delta for this step. Must be >= 0 (cumulative counter).
   * Accepts number or string; normalised to fixed(6) in SQL binding.
   */
  costUsd: number;
}

export type AgentRunFinalStatus =
  | "success"
  | "failed"
  | "timeout"
  | "incoherent";

export interface AgentRunFinish {
  status: AgentRunFinalStatus;
  stopReason?: string;
  errorMessage?: string;
}

export interface AgentRunTracker {
  /** Insert a new row in 'running' status; returns the UUID. */
  start(input: AgentRunStartInput): Promise<string>;
  /** Increment counters atomically. Idempotent per-call (caller dedupes). */
  recordStep(uuid: string, delta: AgentRunStepDelta): Promise<void>;
  /** Terminal transition — sets finished_at + status. */
  finish(uuid: string, result: AgentRunFinish): Promise<void>;
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function assertNonEmpty(name: string, v: unknown): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`agent-run-tracker: ${name} must be a non-empty string`);
  }
}

function assertNonNegativeInt(name: string, v: unknown): asserts v is number {
  if (!Number.isFinite(v) || !Number.isInteger(v) || (v as number) < 0) {
    throw new Error(
      `agent-run-tracker: ${name} must be a non-negative integer`,
    );
  }
}

function assertNonNegativeCost(name: string, v: unknown): asserts v is number {
  if (!Number.isFinite(v) || (v as number) < 0) {
    throw new Error(
      `agent-run-tracker: ${name} must be a non-negative finite number`,
    );
  }
}

function assertUuid(name: string, v: unknown): asserts v is string {
  // Loose uuid check (36 chars with dashes) — DB has full constraint via type.
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  ) {
    throw new Error(`agent-run-tracker: ${name} must be a UUID`);
  }
}

// ─── Implementation ──────────────────────────────────────────────────────────

class AgentRunTrackerImpl implements AgentRunTracker {
  constructor(private readonly db: DbClient) {}

  async start(input: AgentRunStartInput): Promise<string> {
    assertNonEmpty("agentId", input.agentId);
    assertNonEmpty("agentVersion", input.agentVersion);
    assertNonEmpty("runId", input.runId);
    assertNonEmpty("model", input.model);
    assertNonEmpty("provider", input.provider);

    const result = await this.db.query<{ id: string }>(
      `INSERT INTO agent_run
         (agent_id, agent_version, run_id, model, provider,
          tenant_id, trace_id, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', NOW())
       RETURNING id`,
      [
        input.agentId,
        input.agentVersion,
        input.runId,
        input.model,
        input.provider,
        input.tenantId ?? null,
        input.traceId ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("agent-run-tracker: insert did not return an id");
    }
    return row.id;
  }

  async recordStep(uuid: string, delta: AgentRunStepDelta): Promise<void> {
    assertUuid("uuid", uuid);
    assertNonNegativeInt("inputTokens", delta.inputTokens);
    assertNonNegativeInt("outputTokens", delta.outputTokens);
    if (delta.toolCalls !== undefined) {
      assertNonNegativeInt("toolCalls", delta.toolCalls);
    }
    assertNonNegativeCost("costUsd", delta.costUsd);

    // Use numeric addition at the DB for atomicity; bind cost as fixed(6) string
    // to avoid float64 imprecision accumulating over many steps.
    const costStr = delta.costUsd.toFixed(6);

    await this.db.query(
      `UPDATE agent_run
         SET input_tokens     = input_tokens     + $2,
             output_tokens    = output_tokens    + $3,
             tool_calls_count = tool_calls_count + $4,
             cost_usd         = cost_usd         + $5::numeric
       WHERE id = $1
         AND status = 'running'`,
      [
        uuid,
        delta.inputTokens,
        delta.outputTokens,
        delta.toolCalls ?? 0,
        costStr,
      ],
    );
  }

  async finish(uuid: string, result: AgentRunFinish): Promise<void> {
    assertUuid("uuid", uuid);
    const validStatuses: AgentRunFinalStatus[] = [
      "success",
      "failed",
      "timeout",
      "incoherent",
    ];
    if (!validStatuses.includes(result.status)) {
      throw new Error(
        `agent-run-tracker: status must be one of ${validStatuses.join(", ")}`,
      );
    }
    if (
      result.stopReason !== undefined &&
      typeof result.stopReason !== "string"
    ) {
      throw new Error(
        "agent-run-tracker: stopReason must be a string when provided",
      );
    }
    if (
      result.errorMessage !== undefined &&
      typeof result.errorMessage !== "string"
    ) {
      throw new Error(
        "agent-run-tracker: errorMessage must be a string when provided",
      );
    }

    await this.db.query(
      `UPDATE agent_run
         SET status        = $2,
             stop_reason   = $3,
             error_message = $4,
             finished_at   = NOW()
       WHERE id = $1
         AND status = 'running'`,
      [
        uuid,
        result.status,
        result.stopReason ?? null,
        result.errorMessage ?? null,
      ],
    );
  }
}

/** Factory — inject a DbClient (pg.Pool or test mock). */
export function createAgentRunTracker(db: DbClient): AgentRunTracker {
  return new AgentRunTrackerImpl(db);
}
