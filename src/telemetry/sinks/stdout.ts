/**
 * stdoutTelemetrySink — JSON line emission to stderr (dev-friendly default).
 *
 * One JSON object per event, suitable for `jq`, `pino-pretty`, or any
 * structured-log pipeline. Writes to stderr (not stdout) so that the agent's
 * own stdout remains free for user output.
 *
 * Ref: command-center:sprint-693:sink-stdout
 */

import type {
  TelemetryRunFinish,
  TelemetryRunStart,
  TelemetryRunStep,
  TelemetrySink,
} from "../port.js";

/** @public */
export interface StdoutTelemetrySinkOptions {
  /** Stream to write to. Defaults to `process.stderr`. */
  stream?: NodeJS.WritableStream;
  /** When true (default), emits as `key=value` instead of JSON. */
  json?: boolean;
}

/**
 * Default sink for dev visibility. Zero dependency, zero I/O latency
 * (synchronous write to stream).
 * @public
 */
export function stdoutTelemetrySink(opts: StdoutTelemetrySinkOptions = {}): TelemetrySink {
  const stream = opts.stream ?? process.stderr;
  const useJson = opts.json ?? true;

  function emit(event: Record<string, unknown>): void {
    const line = useJson
      ? JSON.stringify(event)
      : Object.entries(event)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
    stream.write(`${line}\n`);
  }

  return {
    name: "stdout",

    async start(event: TelemetryRunStart) {
      emit({ telemetry: "run.start", ...event });
    },

    async step(runId: string, delta: TelemetryRunStep) {
      emit({ telemetry: "run.step", runId, ...delta });
    },

    async finish(runId: string, event: TelemetryRunFinish) {
      emit({ telemetry: "run.finish", runId, ...event });
    },
  };
}
