/**
 * OutcomesClient — REST client for /api/outcomes/* endpoints.
 *
 * Endpoints are defined in sprint-522:quick-4 (command-center HTTP server).
 * This client is the SDK-side contract: route authors must match these shapes.
 *
 * Auth: Bearer token injected via `getToken()` on every call.
 * Error handling: 4xx responses throw OutcomesApiError.
 * No Zod dependency — types are validated structurally at the call site.
 */

import type {
  CfoView,
  Outcome,
  OutcomeSummary,
  OutcomeType,
  RoiPerAgent,
} from "./types.js";

// ─── Error ───────────────────────────────────────────────────────────────────

export class OutcomesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `OutcomesApiError: HTTP ${status}`);
    this.name = "OutcomesApiError";
  }
}

// ─── Filter + response types ─────────────────────────────────────────────────

export interface OutcomesListFilter {
  agentId?: string;
  type?: OutcomeType;
  /** ISO 8601 datetime — inclusive lower bound. */
  from?: string;
  /** ISO 8601 datetime — inclusive upper bound. */
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface OutcomesListResponse {
  items: Outcome[];
  /** Opaque cursor for the next page. Absent when no further pages exist. */
  nextCursor?: string;
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface OutcomesClient {
  /**
   * List outcomes with optional filtering and cursor-based pagination.
   * GET /api/outcomes
   */
  list(filter?: OutcomesListFilter): Promise<OutcomesListResponse>;

  /**
   * Aggregated outcome summary for a time window.
   * GET /api/outcomes/summary?from=...&to=...
   */
  summary(period: { from: string; to: string }): Promise<OutcomeSummary>;

  /**
   * CFO-ready burn-rate and initiative breakdown.
   * GET /api/outcomes/cfo?from=...&to=...
   */
  cfo(period: { from: string; to: string }): Promise<CfoView>;

  /**
   * Per-agent ROI breakdown for a time window.
   * GET /api/outcomes/roi?from=...&to=...
   */
  roi(
    period: { from: string; to: string },
    opts?: { sortBy?: "net_roi_pct" | "value_cents"; limit?: number },
  ): Promise<RoiPerAgent[]>;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export interface OutcomesClientOptions {
  baseUrl: string;
  /** Called before every request to obtain a fresh Bearer token. */
  getToken: () => Promise<string>;
}

class OutcomesClientImpl implements OutcomesClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;

  constructor(opts: OutcomesClientOptions) {
    // Normalise base URL: strip trailing slash to simplify path concatenation.
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.getToken = opts.getToken;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const token = await this.getToken();

    const url = new URL(`${this.baseUrl}${path}`);
    if (params !== undefined) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OutcomesApiError(
        response.status,
        body,
        `OutcomesClient: ${response.status} ${response.statusText} — ${path}`,
      );
    }

    return response.json() as Promise<T>;
  }

  // ── public methods ───────────────────────────────────────────────────────

  async list(filter: OutcomesListFilter = {}): Promise<OutcomesListResponse> {
    return this.request<OutcomesListResponse>("/api/outcomes", {
      agent_id: filter.agentId,
      type: filter.type,
      from: filter.from,
      to: filter.to,
      limit: filter.limit,
      cursor: filter.cursor,
    });
  }

  async summary(period: {
    from: string;
    to: string;
  }): Promise<OutcomeSummary> {
    return this.request<OutcomeSummary>("/api/outcomes/summary", {
      from: period.from,
      to: period.to,
    });
  }

  async cfo(period: { from: string; to: string }): Promise<CfoView> {
    return this.request<CfoView>("/api/outcomes/cfo", {
      from: period.from,
      to: period.to,
    });
  }

  async roi(
    period: { from: string; to: string },
    opts?: { sortBy?: "net_roi_pct" | "value_cents"; limit?: number },
  ): Promise<RoiPerAgent[]> {
    return this.request<RoiPerAgent[]>("/api/outcomes/roi", {
      from: period.from,
      to: period.to,
      sort_by: opts?.sortBy,
      limit: opts?.limit,
    });
  }
}

/**
 * Factory — create an OutcomesClient pointed at a Command Center instance.
 *
 * @example
 * const client = createOutcomesClient({
 *   baseUrl: process.env.COMMAND_CENTER_URL,
 *   getToken: () => auth.getAccessToken(),
 * });
 */
export function createOutcomesClient(
  opts: OutcomesClientOptions,
): OutcomesClient {
  return new OutcomesClientImpl(opts);
}
