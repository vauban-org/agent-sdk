/**
 * OTel SDK initialization for external agents.
 *
 * Phase 2 — sprint-564 hotfix
 *
 * initVaubanSDK() now instantiates a BasicTracerProvider with an OTLP HTTP
 * exporter and a BatchSpanProcessor. No host-side OTel setup is required.
 * The collectorUrl follows the OpenTelemetry convention : the
 * `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable when set, else a
 * collector on localhost. A deployment hostname is configuration, never a
 * default shipped in a public package.
 *
 * @see https://opentelemetry.io/docs/languages/js/instrumentation/
 */

import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { fetchJson } from "../http/fetch-json.js";
import { GEN_AI_AGENT_ID } from "./attributes.js";
import { registerW3CPropagator } from "./trace-context.js";

export type { OtlpSpan, OtlpAttribute, OtlpAttributeValue } from "./types.js";

// ─── Legacy client interface (backward compat) ──────────────────────────────

/** @public */
export interface IngestSpansResult {
  accepted: number;
  skipped?: number;
  runs?: string[];
  warnings?: string[];
}

export interface IngestSpansOptions {
  origin?: string;
}

/** @public */
export interface OtelClient {
  ingestSpans(
    spans: { resourceSpans: unknown[] },
    opts?: IngestSpansOptions,
  ): Promise<IngestSpansResult>;
}

export interface OtelClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
}

/** @public */
export function createOtelClient(opts: OtelClientOptions): OtelClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async ingestSpans(spans, ingestOpts) {
      const token = await opts.getToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (ingestOpts?.origin) headers["X-Origin"] = ingestOpts.origin;

      const response = await fetch(`${base}/api/otel/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify(spans),
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as {
            error?: string;
            message?: string;
          };
          message = body.error ?? body.message ?? message;
        } catch {
          /* ignore */
        }
        throw new Error(`OtelClient.ingestSpans: ${message}`);
      }
      return response.json() as Promise<IngestSpansResult>;
    },
  };
}

// ─── Real OTel SDK init (OTLP HTTP exporter) ───────────────────────────────

/** @public */
export interface VaubanSDKOptions {
  /** Vauban API key for the org (scope: cc:ingest). */
  apiKey: string;
  /**
   * OTLP HTTP collector endpoint.
   * Default: `OTEL_EXPORTER_OTLP_ENDPOINT` when set, else `http://localhost:4318`.
   */
  collectorUrl?: string;
  /** Agent identifier (e.g. "my-product/trading-agent"). */
  agentId: string;
  /** Agent version (semver). */
  agentVersion: string;
  /** Organization ID (e.g. "my-org"). */
  orgId: string;
  /** Enable console exporter for debugging (default: false). */
  debug?: boolean;
  /**
   * Command Center registry URL for auto-registration.
   * When set, initVaubanSDK() sends a POST /api/registry/agents on startup
   * so the agent appears in the dashboard /registry without manual setup.
   * Default: undefined (opt-in — no auto-registration without explicit URL).
   */
  registryUrl?: string;
  /** Human-readable agent name for the registry (default: agentId). */
  agentName?: string;
  /** Capabilities list for the registry (e.g. ["code-generation", "review"]). */
  capabilities?: string[];
  /** Repository URL for the registry card. */
  repoUrl?: string;
}

let _sdkProvider: BasicTracerProvider | null = null;

/**
 * Initialize the Vauban OTel SDK. Call once at process startup.
 *
 * Instantiates a BasicTracerProvider with an OTLP HTTP exporter on the
 * configured collector endpoint, registers process-level resource attributes,
 * and installs a shutdown hook. No host-side OTel setup is required.
 *
 * Returns the tracer provider for introspection.
 * @public
 */
export function initVaubanSDK(opts: VaubanSDKOptions): BasicTracerProvider {
  // Why this default (ADR-ECO-113 A4 delta-scrub, 2026-09-02) : the previous
  // default named an in-cluster host that only resolved inside one deployment.
  // The OpenTelemetry environment convention keeps every deployment explicit.
  const collectorUrl =
    opts.collectorUrl ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  const resource = resourceFromAttributes({
    "service.name": opts.agentId,
    "service.version": opts.agentVersion,
    [GEN_AI_AGENT_ID]: opts.agentId,
    "vauban.org.id": opts.orgId,
  });

  // OTLP HTTP exporter
  const otlpExporter = new OTLPTraceExporter({
    url: `${collectorUrl.replace(/\/$/, "")}/v1/traces`,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });

  const spanProcessors = [new BatchSpanProcessor(otlpExporter)];

  if (opts.debug) {
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  const provider = new BasicTracerProvider({ resource, spanProcessors });
  trace.setGlobalTracerProvider(provider);

  // Register W3C Trace Context propagator so traceparent/tracestate headers
  // are injected/extracted automatically on delegation boundaries.
  registerW3CPropagator();

  // Graceful shutdown
  const shutdown = () => {
    provider.forceFlush().finally(() => provider.shutdown());
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  _sdkProvider = provider;

  if (process.env.VAUBAN_SDK_VERBOSE) {
    // biome-ignore lint/suspicious/noConsoleLog: opt-in VAUBAN_SDK_VERBOSE diagnostic to stdout.
    console.log(
      `[vauban-sdk] OTel enabled -> ${collectorUrl} | agent=${opts.agentId} v${opts.agentVersion}`,
    );
  }

  // ── Auto-registration (fire-and-forget) ─────────────────────────────────
  if (opts.registryUrl) {
    const registryUrl = opts.registryUrl.replace(/\/$/, "");
    _registryBaseUrl = registryUrl;
    _apiKey = opts.apiKey;
    fetch(`${registryUrl}/api/registry/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        agentId: opts.agentId,
        orgId: opts.orgId,
        name: opts.agentName ?? opts.agentId,
        version: opts.agentVersion,
        capabilities: opts.capabilities ?? [],
        repoUrl: opts.repoUrl,
        sdkVersion: "0.14.3",
        metadata: { collectorUrl },
      }),
    })
      .then((res) => {
        if (process.env.VAUBAN_SDK_VERBOSE) {
          if (res.ok) {
            // biome-ignore lint/suspicious/noConsoleLog: opt-in VAUBAN_SDK_VERBOSE diagnostic to stdout.
            console.log(`[vauban-sdk] agent registered -> ${registryUrl}`);
          } else {
            console.warn(`[vauban-sdk] registry returned ${res.status}; agent not registered`);
          }
        }
      })
      .catch((err) => {
        if (process.env.VAUBAN_SDK_VERBOSE) {
          console.warn(
            `[vauban-sdk] registry unreachable; agent not auto-registered: ${
              (err as Error).message
            }`,
          );
        }
      });
  }

  return provider;
}

/** @public */
export function getSDKProvider(): BasicTracerProvider | null {
  return _sdkProvider;
}

// ── Run reporting ────────────────────────────────────────────────────────

let _registryBaseUrl: string | undefined;
let _apiKey: string | undefined;

/**
 * Report a run start to the CC registry.
 * Called automatically by initVaubanSDK when registryUrl is set,
 * and manually by agents that want their cycles to appear in /runs.
 * @public
 */
export async function reportRunStart(opts: {
  agentId: string;
  runId?: string;
  model?: string;
  provider?: string;
}): Promise<{ id: string } | null> {
  const base = _registryBaseUrl;
  const key = _apiKey;
  if (!base || !key) return null;
  try {
    return await fetchJson<{ id: string }>(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        agentId: opts.agentId,
        runId: opts.runId,
        model: opts.model,
        provider: opts.provider,
      }),
    });
  } catch {
    return null;
  }
}

/**
 * Report a run finish to the CC registry.
 * @public
 */
export async function reportRunFinish(opts: {
  runId: string;
  status: "success" | "failed" | "completed";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorMessage?: string;
}): Promise<void> {
  const base = _registryBaseUrl;
  const key = _apiKey;
  if (!base || !key) return;
  try {
    await fetch(`${base}/api/runs/${encodeURIComponent(opts.runId)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        status: opts.status,
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        cost_usd: opts.costUsd,
        error_message: opts.errorMessage,
      }),
    });
  } catch {
    // fire-and-forget
  }
}
