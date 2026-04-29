/**
 * AgentsClient — REST client for /api/agents endpoints.
 *
 * Wraps:
 *   POST /api/agents/execute  → AgentsClient.execute()
 *   GET  /api/agents          → AgentsClient.listRegistry()
 *
 * Authentication: Bearer token injected via getToken() on every request.
 * Timeout: 30s for execute (agent calls can be slow), 10s for reads.
 *
 * Sprint: command-center:sprint-524:quick-9
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AgentExecuteInput {
  agentId: string;
  taskType: string;
  description: string;
  archiveToBrain?: boolean;
}

export interface AgentExecuteResult {
  runId: string;
  runUrl: string;
  status: string;
}

export interface AgentRegistryEntry {
  agentId: string;
  type: string;
  status: string;
}

export interface AgentsClient {
  execute(input: AgentExecuteInput): Promise<AgentExecuteResult>;
  listRegistry(): Promise<{ agents: AgentRegistryEntry[] }>;
}

export interface AgentsClientOptions {
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

/**
 * Parse the backend /api/agents/execute response into AgentExecuteResult.
 *
 * The backend execute endpoint is synchronous and does not assign a run UUID today.
 * We synthesise a deterministic runId from a timestamp + random suffix so the
 * caller always gets a stable reference for UI links.
 */
function parseExecuteResponse(
  raw: Record<string, unknown>,
  base: string,
): AgentExecuteResult {
  const runId =
    typeof raw.runId === "string"
      ? raw.runId
      : `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runUrl = `${base}/runs/${runId}`;
  const status =
    typeof raw.status === "string"
      ? raw.status
      : raw.error !== undefined
        ? "failed"
        : "completed";
  return { runId, runUrl, status };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAgentsClient(opts: AgentsClientOptions): AgentsClient {
  const base = opts.baseUrl.replace(/\/$/, "");

  return {
    async execute(input: AgentExecuteInput): Promise<AgentExecuteResult> {
      const headers = await buildHeaders(opts.getToken);

      const res = await fetch(`${base}/api/agents/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentType: input.agentId,
          taskType: input.taskType,
          description: input.description,
          archive: input.archiveToBrain ?? false,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => String(res.status));
        throw new Error(`AgentsClient.execute failed (${res.status}): ${body}`);
      }

      const raw = (await res.json()) as Record<string, unknown>;
      return parseExecuteResponse(raw, base);
    },

    async listRegistry(): Promise<{ agents: AgentRegistryEntry[] }> {
      const headers = await buildHeaders(opts.getToken);

      const res = await fetch(`${base}/api/agents`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => String(res.status));
        throw new Error(
          `AgentsClient.listRegistry failed (${res.status}): ${body}`,
        );
      }

      const raw = (await res.json()) as {
        agents?: Array<{ type?: string; displayName?: string }>;
      };
      const agents: AgentRegistryEntry[] = (raw.agents ?? []).map((a) => ({
        agentId: typeof a.type === "string" ? a.type : "unknown",
        type: typeof a.type === "string" ? a.type : "unknown",
        status: "active",
      }));

      return { agents };
    },
  };
}
