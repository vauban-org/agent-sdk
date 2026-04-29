/**
 * createOtelClient — OTLP HTTP/JSON ingest helper for SDK clients.
 *
 * POSTs OTLP spans to /api/otel/ingest with cc:otel-ingest scope.
 * Designed for LangGraph / AutoGen / custom agentic clients to push spans
 * into CC's audit pipeline so ingested runs ride the same daily anchoring
 * path as CC-native runs.
 *
 * Sprint: command-center:sprint-523:quick-6
 */

import type { OtlpRequest } from "./types.js";

export type { OtlpRequest };
export type { OtlpSpan, OtlpAttribute, OtlpAttributeValue } from "./types.js";

export interface IngestSpansResult {
  accepted: number;
  skipped?: number;
  runs?: string[];
  warnings?: string[];
}

export interface IngestSpansOptions {
  /** Identifies the caller in rate-limit accounting (cc:otel-ingest origin). */
  origin?: string;
}

export interface OtelClient {
  ingestSpans(
    spans: OtlpRequest,
    opts?: IngestSpansOptions,
  ): Promise<IngestSpansResult>;
}

export interface OtelClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
}

export function createOtelClient(opts: OtelClientOptions): OtelClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async ingestSpans(spans, ingestOpts) {
      const token = await opts.getToken();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      if (ingestOpts?.origin) {
        headers["X-Origin"] = ingestOpts.origin;
      }

      const response = await fetch(`${base}/api/otel/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify(spans),
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = await response.json() as { error?: string; message?: string };
          message = body.error ?? body.message ?? message;
        } catch {
          // Ignore JSON parse errors — use the status message.
        }
        throw new Error(`OtelClient.ingestSpans: ${message}`);
      }

      return response.json() as Promise<IngestSpansResult>;
    },
  };
}
