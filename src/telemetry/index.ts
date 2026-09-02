/**
 * Public telemetry API for agent-sdk consumers.
 *
 * Per ADR-ECO-039. Sovereign multi-sink observability for OODA agents.
 *
 * @example
 * ```ts
 * import {
 *   createOODAAgent,
 *   stdoutTelemetrySink,
 *   localSqliteTelemetrySink,
 * } from "@vauban-org/agent-sdk";
 *
 * createOODAAgent({
 *   agentId: "my-agent",
 *   telemetry: {
 *     sinks: [
 *       stdoutTelemetrySink(),
 *       localSqliteTelemetrySink(),
 *     ],
 *   },
 * });
 * ```
 */

export { NOOP_TELEMETRY_SINK, TelemetrySinkError } from "./port.js";
export type {
  TelemetryRunStatus,
  TelemetryRunFinish,
  TelemetryRunStart,
  TelemetryRunStep,
  TelemetrySink,
} from "./port.js";

export { createTelemetryBus } from "./bus.js";
export type {
  TelemetryBusOptions,
  TelemetryCounters,
  TelemetryLogger,
} from "./bus.js";

export { stdoutTelemetrySink } from "./sinks/stdout.js";
export type { StdoutTelemetrySinkOptions } from "./sinks/stdout.js";

export { localSqliteTelemetrySink } from "./sinks/sqlite.js";
export type { LocalSqliteTelemetrySinkOptions } from "./sinks/sqlite.js";

export { otlpTelemetrySink } from "./sinks/otlp.js";
export type { OtlpTelemetrySinkOptions } from "./sinks/otlp.js";
