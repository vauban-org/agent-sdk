/**
 * TelemetryBus — fanout to multiple {@link TelemetrySink}s, non-blocking.
 *
 * Invariants :
 *   1. Sink failures are ISOLATED — one sink throwing never affects the others
 *      nor the host agent loop. Failures are logged via the bus logger.
 *   2. The bus itself implements {@link TelemetrySink}, so it can be passed
 *      transparently to consumers expecting a single sink (composition).
 *   3. When `nonBlocking: true` (default), `start`/`step`/`finish` return
 *      immediately and dispatch in background. Errors surface via the logger.
 *   4. Backpressure : if internal queue > `maxQueueDepth`, oldest events are
 *      dropped and counted.
 *
 * Ref: command-center:sprint-693:telemetry-bus
 */

import {
  NOOP_TELEMETRY_SINK,
  type TelemetryRunFinish,
  type TelemetryRunStart,
  type TelemetryRunStep,
  type TelemetrySink,
} from "./port.js";

// ─── Minimal logger interface (avoid SDK dep) ────────────────────────────────

/** @public */
export interface TelemetryLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const NOOP_LOGGER: TelemetryLogger = {
  warn: () => {
    /* no-op */
  },
  error: () => {
    /* no-op */
  },
};

// ─── Bus options ─────────────────────────────────────────────────────────────

/** @public */
export interface TelemetryBusOptions {
  sinks: readonly TelemetrySink[];
  /** Pino-compatible logger. Defaults to no-op. */
  logger?: TelemetryLogger;
  /**
   * When true (default), `start/step/finish` resolve immediately and dispatch
   * in background. Set false in tests for deterministic assertions.
   */
  nonBlocking?: boolean;
  /**
   * Max number of in-flight events per sink before dropping oldest.
   * Defaults to 1000.
   */
  maxQueueDepth?: number;
}

// ─── Telemetry counters (exposed for Prometheus or tests) ────────────────────

/** @public */
export interface TelemetryCounters {
  /** Events dropped due to queue overflow. */
  readonly dropped: number;
  /** Sink errors caught and isolated. */
  readonly sinkErrors: number;
  /** Events successfully dispatched. */
  readonly dispatched: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

interface PendingEvent {
  kind: "start" | "step" | "finish";
  exec: (sink: TelemetrySink) => Promise<unknown>;
}

class TelemetryBusImpl implements TelemetrySink {
  readonly name = "telemetry-bus";

  private readonly _sinks: readonly TelemetrySink[];
  private readonly _logger: TelemetryLogger;
  private readonly _nonBlocking: boolean;
  private readonly _maxQueueDepth: number;
  /** Per-sink queue of pending events (FIFO). */
  private readonly _queues: PendingEvent[][];
  /** Per-sink drain promise (single-flight). */
  private readonly _draining: Array<Promise<void> | null>;

  private _dropped = 0;
  private _sinkErrors = 0;
  private _dispatched = 0;

  constructor(opts: TelemetryBusOptions) {
    this._sinks = opts.sinks;
    this._logger = opts.logger ?? NOOP_LOGGER;
    this._nonBlocking = opts.nonBlocking ?? true;
    this._maxQueueDepth = opts.maxQueueDepth ?? 1000;
    this._queues = this._sinks.map(() => []);
    this._draining = this._sinks.map(() => null);
  }

  get counters(): TelemetryCounters {
    return {
      dropped: this._dropped,
      sinkErrors: this._sinkErrors,
      dispatched: this._dispatched,
    };
  }

  async start(event: TelemetryRunStart): Promise<void> {
    return this._fanout({
      kind: "start",
      exec: (s) => s.start(event),
    });
  }

  async step(runId: string, delta: TelemetryRunStep): Promise<void> {
    return this._fanout({
      kind: "step",
      exec: (s) => s.step(runId, delta),
    });
  }

  async finish(runId: string, event: TelemetryRunFinish): Promise<void> {
    return this._fanout({
      kind: "finish",
      exec: (s) => s.finish(runId, event),
    });
  }

  async flush(): Promise<void> {
    await Promise.all([
      ...this._draining.map((p) => p ?? Promise.resolve()),
      ...this._sinks.map((s) =>
        s.flush?.().catch((err) => {
          this._sinkErrors += 1;
          this._logger.warn(
            { sink: s.name, err: errorMessage(err) },
            "telemetry-bus: flush failed",
          );
        }),
      ),
    ]);
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private async _fanout(evt: PendingEvent): Promise<void> {
    if (this._nonBlocking) {
      // Enqueue on each sink, kick drain in background.
      this._sinks.forEach((_, i) => this._enqueue(i, evt));
      return;
    }
    // Blocking mode (tests) — dispatch sequentially and surface errors via log.
    await Promise.all(this._sinks.map((sink) => this._dispatchOne(sink, evt)));
  }

  private _enqueue(sinkIdx: number, evt: PendingEvent): void {
    const queue = this._queues[sinkIdx];
    if (queue.length >= this._maxQueueDepth) {
      queue.shift(); // drop oldest
      this._dropped += 1;
      const sink = this._sinks[sinkIdx];
      this._logger.warn(
        { sink: sink.name, depth: queue.length, dropped: this._dropped },
        "telemetry-bus: queue overflow, oldest dropped",
      );
    }
    queue.push(evt);
    void this._drain(sinkIdx);
  }

  private async _drain(sinkIdx: number): Promise<void> {
    if (this._draining[sinkIdx]) return;
    const sink = this._sinks[sinkIdx];
    const queue = this._queues[sinkIdx];

    const promise = (async () => {
      while (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: value is guaranteed present here (tsc-verified non-null assertion).
        const evt = queue.shift()!;
        await this._dispatchOne(sink, evt);
      }
    })();
    this._draining[sinkIdx] = promise;
    try {
      await promise;
    } finally {
      this._draining[sinkIdx] = null;
    }
  }

  private async _dispatchOne(sink: TelemetrySink, evt: PendingEvent): Promise<void> {
    try {
      await evt.exec(sink);
      this._dispatched += 1;
    } catch (err) {
      this._sinkErrors += 1;
      this._logger.warn(
        {
          sink: sink.name,
          kind: evt.kind,
          err: errorMessage(err),
        },
        "telemetry-bus: sink dispatch failed (isolated)",
      );
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a TelemetryBus that fans events to all sinks non-blockingly.
 *
 * If `sinks` is empty, returns {@link NOOP_TELEMETRY_SINK} so callers never
 * need to null-check.
 * @public
 */
export function createTelemetryBus(
  opts: TelemetryBusOptions,
): TelemetrySink & { counters: TelemetryCounters; flush(): Promise<void> } {
  if (opts.sinks.length === 0) {
    // Wrap NOOP with stub counters + flush for type consistency.
    return {
      ...NOOP_TELEMETRY_SINK,
      counters: { dropped: 0, sinkErrors: 0, dispatched: 0 },
      async flush() {
        /* no-op */
      },
    };
  }
  return new TelemetryBusImpl(opts);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
