/**
 * OTLP HTTP/JSON type shim — @vauban-org/agent-sdk v0.5.3 (sprint-523 Bloc 3).
 *
 * Mirrors src/otel/otlp-decoder.ts so clients building OTLP payloads
 * (LangGraph, AutoGen, custom exporters) can type-check their spans
 * without depending on the command-center server source.
 *
 * These types follow the OTLP HTTP/JSON wire format:
 *   https://opentelemetry.io/docs/specs/otlp/#otlphttp
 */

export interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
  arrayValue?: { values: OtlpAttributeValue[] };
}

export interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: { code: number; message?: string };
}

export interface OtlpScopeSpans {
  scope: { name: string; version?: string };
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: OtlpScopeSpans[];
}

export interface OtlpRequest {
  resourceSpans: OtlpResourceSpans[];
}
