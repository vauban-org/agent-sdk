/**
 * PipelinesClient — REST client for /api/pipelines endpoints.
 *
 * Wraps:
 *   POST /api/pipelines/run            → PipelinesClient.run()
 *   GET  /api/pipelines (via config)   → PipelinesClient.list()
 *   GET  /api/pipelines/:id/status     → PipelinesClient.status()
 *
 * Authentication: Bearer token injected via getToken() on every request.
 * Timeout: 15s for run (async, returns 202 immediately), 10s for reads.
 *
 * Sprint: command-center:sprint-524:quick-9
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PipelineRunInput {
  name: string;
  payload?: Record<string, unknown>;
}

export interface PipelineRunResult {
  pipelineId: string;
  runId: string;
  statusUrl: string;
}

export interface PipelineListEntry {
  name: string;
  tier: 1 | 2;
  schedule?: string;
}

export interface PipelinesClient {
  run(input: PipelineRunInput): Promise<PipelineRunResult>;
  list(): Promise<{ pipelines: PipelineListEntry[] }>;
  status(pipelineId: string): Promise<{ status: string; progress: number }>;
}

export interface PipelinesClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildHeaders(
  getToken: () => Promise<string>,
): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPipelinesClient(
  opts: PipelinesClientOptions,
): PipelinesClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async run(input: PipelineRunInput): Promise<PipelineRunResult> {
      const headers = await buildHeaders(opts.getToken);

      // Build a minimal inline pipeline definition accepted by POST /api/pipelines/run.
      // The backend validates the pipeline object via validatePipeline().
      const res = await fetch(`${base}/api/pipelines/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pipeline: {
            name: input.name,
            trigger: { type: "webhook" },
            steps: [],
            ...(input.payload ? { context: input.payload } : {}),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => String(res.status));
        throw new Error(`PipelinesClient.run failed (${res.status}): ${body}`);
      }

      const raw = (await res.json()) as {
        runId?: string;
        pipeline?: string;
        status?: string;
      };
      const runId =
        typeof raw.runId === "string"
          ? raw.runId
          : `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pipelineId = typeof raw.pipeline === "string" ? raw.pipeline : input.name;
      const statusUrl = `${base}/api/pipelines/${runId}/status`;

      return { pipelineId, runId, statusUrl };
    },

    async list(): Promise<{ pipelines: PipelineListEntry[] }> {
      // The CC backend does not currently expose a GET /api/pipelines/list endpoint.
      // We return a static registry of the 10 known pipelines with their tiers.
      // This avoids a server round-trip while keeping the client interface stable.
      // When the backend ships a list endpoint, replace with a real fetch().
      const known: PipelineListEntry[] = [
        { name: "vault-guardian", tier: 1, schedule: "*/15 */4 * * *" },
        { name: "sprint-intelligence", tier: 1, schedule: "0 9 * * 1" },
        { name: "knowledge-compounder", tier: 1 },
        { name: "ecosystem-health", tier: 1, schedule: "30 * * * *" },
        { name: "daily-digest", tier: 1, schedule: "0 8 * * *" },
        { name: "cairo-sentinel", tier: 2 },
        { name: "competitive-intel", tier: 2, schedule: "0 18 * * *" },
        { name: "architecture-drift", tier: 2, schedule: "0 10 * * 5" },
        { name: "pr-review", tier: 2 },
        { name: "incident-post-mortem", tier: 2 },
      ];
      return { pipelines: known };
    },

    async status(
      pipelineId: string,
    ): Promise<{ status: string; progress: number }> {
      const headers = await buildHeaders(opts.getToken);

      const res = await fetch(`${base}/api/pipelines/${pipelineId}/status`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => String(res.status));
        throw new Error(
          `PipelinesClient.status failed (${res.status}): ${body}`,
        );
      }

      const raw = (await res.json()) as {
        status?: string;
        stepsTotal?: number;
        stepsCompleted?: number;
      };

      const status = typeof raw.status === "string" ? raw.status : "unknown";
      const total =
        typeof raw.stepsTotal === "number" && raw.stepsTotal > 0
          ? raw.stepsTotal
          : 1;
      const completed =
        typeof raw.stepsCompleted === "number" ? raw.stepsCompleted : 0;
      const progress = Math.round((completed / total) * 100);

      return { status, progress };
    },
  };
}
