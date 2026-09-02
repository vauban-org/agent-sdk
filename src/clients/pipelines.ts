/**
 * PipelinesClient — REST client for /api/pipelines endpoints.
 *
 * @deprecated The `/api/pipelines/*` HTTP API was removed from the command-center
 * backend (sprint-623) in favor of OODA agents scheduled via GitHub Actions.
 * Every method on this client now throws {@link PipelineApiRemovedError} at call
 * time. There is no working replacement client to swap in — pipeline triggering
 * is no longer an HTTP-exposed capability. This export is kept for source
 * compatibility only and will be removed in a future major version.
 *
 * Historical shape (pre-removal):
 *   POST /api/pipelines/run            → PipelinesClient.run()
 *   GET  /api/pipelines (via config)   → PipelinesClient.list()
 *   GET  /api/pipelines/:id/status     → PipelinesClient.status()
 *
 * Sprint: command-center:sprint-524:quick-9 (original) / sprint-850:quick-7 (deprecation)
 * @public
 */

import { deprecated } from "../deprecation.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PipelineRunInput {
  name: string;
  payload?: Record<string, unknown>;
}

/** @public */
export interface PipelineRunResult {
  pipelineId: string;
  runId: string;
  statusUrl: string;
}

/** @public */
export interface PipelineListEntry {
  name: string;
  tier: 1 | 2;
  schedule?: string;
}

/** @public */
export interface PipelinesClient {
  /** @deprecated see {@link PipelinesClient} class doc ; throws {@link PipelineApiRemovedError}. */
  run(input: PipelineRunInput): Promise<PipelineRunResult>;
  /** @deprecated see {@link PipelinesClient} class doc ; throws {@link PipelineApiRemovedError}. */
  list(): Promise<{ pipelines: PipelineListEntry[] }>;
  /** @deprecated see {@link PipelinesClient} class doc ; throws {@link PipelineApiRemovedError}. */
  status(pipelineId: string): Promise<{ status: string; progress: number }>;
}

/** @public */
export interface PipelinesClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
}

// ─── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by every {@link PipelinesClient} method. The `/api/pipelines/*` HTTP
 * API was removed from the command-center backend (sprint-623) ; pipeline
 * execution is now driven by OODA agents scheduled via GitHub Actions, which
 * has no HTTP trigger surface for this client to call.
 * @public
 */
export class PipelineApiRemovedError extends Error {
  constructor(method: "run" | "list" | "status") {
    super(
      `PipelinesClient.${method}() is non-functional: the /api/pipelines/* HTTP API was removed from command-center (sprint-623) and its last dead MCP callers were deleted in sprint-850. Pipelines now run as OODA agents scheduled via GitHub Actions ; there is no HTTP endpoint left to call. PipelinesClient is deprecated and will be removed in a future major version of @vauban-org/agent-sdk.`,
    );
    this.name = "PipelineApiRemovedError";
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * @deprecated Non-functional. See {@link PipelinesClient} class doc. Every
 * method on the returned client throws {@link PipelineApiRemovedError}.
 * @public
 */
export function createPipelinesClient(_opts: PipelinesClientOptions): PipelinesClient {
  deprecated("createPipelinesClient", {
    since: "0.8.2",
    removeIn: "next major",
    replacement: "OODA agents scheduled via GitHub Actions (no HTTP client replacement)",
    note: "/api/pipelines/* was removed from command-center in sprint-623 ; every method throws PipelineApiRemovedError",
  });

  return {
    async run(_input: PipelineRunInput): Promise<PipelineRunResult> {
      throw new PipelineApiRemovedError("run");
    },

    async list(): Promise<{ pipelines: PipelineListEntry[] }> {
      throw new PipelineApiRemovedError("list");
    },

    async status(_pipelineId: string): Promise<{ status: string; progress: number }> {
      throw new PipelineApiRemovedError("status");
    },
  };
}
