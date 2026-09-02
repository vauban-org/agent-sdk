/**
 * cost-accounting-port.ts ; per-cycle LLM cost telemetry (ADR-ECO-101 W0).
 *
 * A decorator over `LLMProviderPort` that aggregates cost / token / cache-hit /
 * latency telemetry PER OODA CYCLE (`metadata.correlationId`) and PER WORKER
 * (`metadata.agentId`), exposing a `snapshot()`. The signal a fleet needs to
 * decide caching / batching on MEASURED cost instead of a guess.
 *
 * Decoupling: the exact decorator idiom of `createTracedLLMProviderPort`
 * (../ports/llm-provider.ts) ; a consumer keeps its single `provider.complete()`
 * call and never learns about accounting. Reuses the raw `ChatUsage` already
 * returned by every adapter (inputTokens / costUsd / cacheReadTokens).
 *
 * Promoted into the published SDK per ADR-ECO-101 (W0 GATE). L1 evidence: the
 * BTC best-execution pilot (command-center apps/agents/btc-execution, commit
 * 4312fff3 ; 9 unit tests). Reusable by any agent that injects an LLMProviderPort.
 *
 * Determinism: pure given (inputs, injected `now`). The only wall-clock read is
 * the injected `now()` (default `Date.now`), so a test / replay can make latency
 * deterministic.
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LLMProviderPort,
  StreamDelta,
} from "../ports/llm-provider.js";

/** Aggregated accounting for one (cycle, worker) cell, or a grouped roll-up. */
export interface CostRecord {
  /** OODA cycle id (`metadata.correlationId`), or `"*"` for a roll-up. */
  readonly correlationId: string;
  /** Worker id (`metadata.agentId`), or `"*"` for a roll-up. */
  readonly agentId: string;
  readonly callCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** Calls that threw OR returned `finishReason: "error"`. */
  readonly errorCount: number;
}

/** A point-in-time view of accumulated cost telemetry. */
export interface CostAccountingSnapshot {
  /** Roll-up across every (cycle, worker) cell. */
  readonly totals: CostRecord;
  /** One record per distinct OODA cycle (`correlationId`). */
  readonly byCycle: readonly CostRecord[];
  /** One record per distinct worker (`agentId`). */
  readonly byWorker: readonly CostRecord[];
  /**
   * `cacheReadTokens / (inputTokens + cacheReadTokens)` over all cells, in
   * `[0, 1]` ; `0` when no input tokens were seen. The signal that decides
   * whether semantic-cache (W4) is worth building beyond native prompt-cache.
   */
  readonly cacheHitRatio: number;
}

/** An `LLMProviderPort` that also exposes accumulated cost telemetry. */
export interface CostAccountingPort extends LLMProviderPort {
  /** Snapshot the accumulated telemetry (does not reset). */
  snapshot(): CostAccountingSnapshot;
  /** Clear all accumulated telemetry. */
  reset(): void;
}

export interface CostAccountingOptions {
  /**
   * Monotonic clock in ms. Defaults to `Date.now` in production ; inject a fake
   * in tests/replay so latency aggregation is deterministic.
   */
  readonly now?: () => number;
}

const UNKNOWN = "unknown";
const ROLLUP = "*";
const KEY_SEP = "\u0000";

interface MutableRecord {
  correlationId: string;
  agentId: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  latencyMs: number;
  errorCount: number;
}

function fresh(correlationId: string, agentId: string): MutableRecord {
  return {
    correlationId,
    agentId,
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    errorCount: 0,
  };
}

function addUsage(
  target: MutableRecord,
  usage: ChatUsage,
  latencyMs: number,
  isError: boolean,
): void {
  target.callCount += 1;
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
  target.cacheReadTokens += usage.cacheReadTokens ?? 0;
  target.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  target.costUsd += usage.costUsd ?? 0;
  target.latencyMs += latencyMs;
  if (isError) target.errorCount += 1;
}

function mergeInto(target: MutableRecord, src: MutableRecord): void {
  target.callCount += src.callCount;
  target.inputTokens += src.inputTokens;
  target.outputTokens += src.outputTokens;
  target.cacheReadTokens += src.cacheReadTokens;
  target.cacheCreationTokens += src.cacheCreationTokens;
  target.costUsd += src.costUsd;
  target.latencyMs += src.latencyMs;
  target.errorCount += src.errorCount;
}

/** Group ledger cells by one dimension, emitting a `CostRecord` per group key. */
function groupBy(
  cells: Iterable<MutableRecord>,
  dimension: (r: MutableRecord) => string,
): CostRecord[] {
  const groups = new Map<string, MutableRecord>();
  for (const cell of cells) {
    const key = dimension(cell);
    let acc = groups.get(key);
    if (!acc) {
      acc = dimension === byCorrelation ? fresh(key, ROLLUP) : fresh(ROLLUP, key);
      groups.set(key, acc);
    }
    mergeInto(acc, cell);
  }
  return [...groups.values()];
}

const byCorrelation = (r: MutableRecord): string => r.correlationId;
const byAgent = (r: MutableRecord): string => r.agentId;

const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Wrap any `LLMProviderPort` with per-cycle / per-worker cost accounting.
 *
 * @param impl    the concrete provider to decorate (tiering router, adapter, ...)
 * @param options injected clock for deterministic latency in tests/replay
 */
export function createCostAccountingPort(
  impl: LLMProviderPort,
  options: CostAccountingOptions = {},
): CostAccountingPort {
  const now = options.now ?? Date.now;
  const ledger = new Map<string, MutableRecord>();

  function cell(correlationId: string, agentId: string): MutableRecord {
    const key = `${correlationId}${KEY_SEP}${agentId}`;
    let rec = ledger.get(key);
    if (!rec) {
      rec = fresh(correlationId, agentId);
      ledger.set(key, rec);
    }
    return rec;
  }

  return {
    async complete(req: ChatRequest): Promise<ChatResponse> {
      const correlationId = req.metadata?.correlationId ?? UNKNOWN;
      const agentId = req.metadata?.agentId ?? UNKNOWN;
      const start = now();
      try {
        const resp = await impl.complete(req);
        addUsage(
          cell(correlationId, agentId),
          resp.usage,
          now() - start,
          resp.finishReason === "error",
        );
        return resp;
      } catch (err) {
        addUsage(cell(correlationId, agentId), ZERO_USAGE, now() - start, true);
        throw err;
      }
    },

    async *stream(req: ChatRequest): AsyncIterable<StreamDelta> {
      if (!impl.stream) return;
      yield* impl.stream(req);
    },

    estimateCost(req: ChatRequest): { usd: number } {
      return impl.estimateCost?.(req) ?? { usd: 0 };
    },

    snapshot(): CostAccountingSnapshot {
      const cells = [...ledger.values()];
      const totals = fresh(ROLLUP, ROLLUP);
      for (const c of cells) mergeInto(totals, c);
      const denom = totals.inputTokens + totals.cacheReadTokens;
      return {
        totals,
        byCycle: groupBy(cells, byCorrelation),
        byWorker: groupBy(cells, byAgent),
        cacheHitRatio: denom === 0 ? 0 : totals.cacheReadTokens / denom,
      };
    },

    reset(): void {
      ledger.clear();
    },
  };
}
