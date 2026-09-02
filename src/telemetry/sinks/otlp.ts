/**
 * otlpTelemetrySink — OTLP/HTTP exporter for agent runs.
 *
 * Maps {@link TelemetryRunStart} / Step / Finish to OpenTelemetry spans using
 * GenAI semantic conventions. Sends as protobuf-over-HTTP to any compliant
 * OTLP receiver (Tempo, Jaeger, Langfuse self-host, Honeycomb…).
 *
 * Lightweight implementation : JSON over HTTP `application/json` rather than
 * protobuf to avoid pulling in `@opentelemetry/exporter-trace-otlp-proto`.
 * The OTel spec allows JSON-encoded OTLP as a first-class transport (since
 * v1.0). This keeps the SDK zero-dep — no `@opentelemetry/*` runtime needed.
 *
 * Ref: command-center:sprint-693:sink-otlp
 */

import { fetchOrThrow } from "../../http/fetch-json.js";
import type {
  TelemetryRunFinish,
  TelemetryRunStart,
  TelemetryRunStep,
  TelemetrySink,
} from "../port.js";

/** @public */
export interface OtlpTelemetrySinkOptions {
  /**
   * OTLP/HTTP endpoint base URL (no trailing slash).
   * Example : `https://langfuse.vauban.tech/api/public/otel`
   * Path `/v1/traces` is appended automatically.
   */
  url: string;
  /** Static headers (Authorization, x-tenant-id, …). */
  headers?: Record<string, string>;
  /**
   * Service name attached to every span. Defaults to `"vauban-agent-sdk"`.
   * Override per-deployment to disambiguate in your tracing backend.
   */
  serviceName?: string;
  /**
   * fetch implementation override (for tests). Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Request timeout in ms. Defaults to 5000.
   */
  timeoutMs?: number;
}

// ─── Run state cache (correlate step→span) ───────────────────────────────────

interface RunState {
  traceId: string;
  spanId: string;
  startUnixNano: string;
  attributes: Record<string, string | number>;
  steps: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HEX = "0123456789abcdef";

function randHex(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes * 2; i++) {
    s += HEX[Math.floor(Math.random() * 16)];
  }
  return s;
}

function isoToUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return `${Date.now() * 1_000_000}`;
  return `${ms * 1_000_000}`;
}

function toKeyValue(attrs: Record<string, unknown>): Array<{
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}> {
  const out: ReturnType<typeof toKeyValue> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") {
      out.push({
        key: k,
        value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
      });
    } else {
      out.push({ key: k, value: { stringValue: String(v) } });
    }
  }
  return out;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an OTLP/HTTP sink. The sink batches at the bus level (FIFO), so
 * one HTTP request is sent per event in this minimal implementation.
 * High-volume deployments should wrap with an upstream batcher.
 * @public
 */
export function otlpTelemetrySink(opts: OtlpTelemetrySinkOptions): TelemetrySink {
  const baseUrl = opts.url.replace(/\/+$/, "");
  const tracesUrl = `${baseUrl}/v1/traces`;
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  const serviceName = opts.serviceName ?? "vauban-agent-sdk";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const runStates = new Map<string, RunState>();

  async function postSpan(span: Record<string, unknown>): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: toKeyValue({
              "service.name": serviceName,
              "telemetry.sdk.name": "vauban-agent-sdk",
              "telemetry.sdk.language": "nodejs",
            }),
          },
          scopeSpans: [
            {
              scope: { name: "vauban.agent.ooda", version: "1.3.0" },
              spans: [span],
            },
          ],
        },
      ],
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetchOrThrow(
        tracesUrl,
        { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal },
        { fetchFn: fetchImpl, label: "OTLP", bodySnippetLength: 200 },
      );
    } finally {
      clearTimeout(t);
    }
  }

  return {
    name: "otlp",

    async start(event: TelemetryRunStart) {
      const traceId = event.traceId ?? randHex(16);
      const spanId = randHex(8);
      runStates.set(event.runId, {
        traceId,
        spanId,
        startUnixNano: isoToUnixNano(event.startedAt),
        attributes: {
          "vauban.run_id": event.runId,
          "vauban.agent.id": event.agentId,
          "vauban.agent.version": event.agentVersion,
          "gen_ai.system": event.provider,
          "gen_ai.request.model": event.model,
          ...(event.tenantId ? { "vauban.tenant.id": event.tenantId } : {}),
        },
        steps: 0,
      });
      // Don't post yet — wait for finish to send full span (start+end).
    },

    async step(runId: string, delta: TelemetryRunStep) {
      const state = runStates.get(runId);
      if (!state) return;
      state.steps += 1;
      // Emit a child span per step for granular tracing.
      const stepStart = isoToUnixNano(new Date().toISOString());
      const durationNs = (delta.durationMs ?? 0) * 1_000_000;
      const stepSpan = {
        traceId: state.traceId,
        spanId: randHex(8),
        parentSpanId: state.spanId,
        name: `ooda.${delta.kind}`,
        kind: 1, // SPAN_KIND_INTERNAL
        startTimeUnixNano: stepStart,
        endTimeUnixNano: String(BigInt(stepStart) + BigInt(durationNs)),
        attributes: toKeyValue({
          "vauban.step.index": delta.stepIndex,
          "vauban.step.kind": delta.kind,
          "vauban.step.status": delta.status,
          "gen_ai.usage.input_tokens": delta.inputTokens,
          "gen_ai.usage.output_tokens": delta.outputTokens,
          "vauban.step.tool_calls": delta.toolCalls ?? 0,
          "vauban.step.cost_usd": delta.costUsd,
        }),
        status: {
          code: delta.status === "failed" ? 2 : 1, // ERROR=2, OK=1
        },
      };
      await postSpan(stepSpan);
    },

    async finish(runId: string, event: TelemetryRunFinish) {
      const state = runStates.get(runId);
      if (!state) return;
      runStates.delete(runId);

      const endNano = isoToUnixNano(event.finishedAt);
      const span = {
        traceId: state.traceId,
        spanId: state.spanId,
        name: `ooda.cycle.${state.attributes["vauban.agent.id"] ?? "agent"}`,
        kind: 1,
        startTimeUnixNano: state.startUnixNano,
        endTimeUnixNano: endNano,
        attributes: toKeyValue({
          ...state.attributes,
          "vauban.run.status": event.status,
          ...(event.stopReason ? { "vauban.run.stop_reason": event.stopReason } : {}),
          ...(event.totalInputTokens !== undefined
            ? { "gen_ai.usage.input_tokens": event.totalInputTokens }
            : {}),
          ...(event.totalOutputTokens !== undefined
            ? { "gen_ai.usage.output_tokens": event.totalOutputTokens }
            : {}),
          ...(event.totalCostUsd !== undefined
            ? { "vauban.run.cost_usd": event.totalCostUsd }
            : {}),
          "vauban.run.steps": state.steps,
        }),
        status: {
          code: event.status === "failed" || event.status === "incoherent" ? 2 : 1,
          ...(event.errorMessage ? { message: event.errorMessage } : {}),
        },
      };
      await postSpan(span);
    },
  };
}
