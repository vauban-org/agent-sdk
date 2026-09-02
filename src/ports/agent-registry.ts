/**
 * AgentRegistryPort — discovery contract for named, capability-tagged agents.
 *
 * Enables the Orchestrator and GTM Arbiter (Forge) to discover agents by
 * capability without depending on a concrete registry implementation. SaaS
 * clients register their own agents by calling `register()`.
 *
 * Two adapters ship with the SDK:
 *   - `MemoryAgentRegistry`   — zero-dependency, suitable for tests and
 *                               single-process deployments.
 *   - `PostgresAgentRegistry` — persistent, multi-tenant via RLS.
 *
 * @module ports/agent-registry
 */

// ─── AgentDescriptor ─────────────────────────────────────────────────────────

/**
 * Descriptor for a registered agent. All fields are immutable after
 * `register()`. Use `unregister + register` to update.
 *
 * `id` format: `<product>:<slug>` (e.g. `"forge:01-revenue"`).
 * Callers SHOULD follow that convention but it is not enforced here.
 * @public
 */
export interface AgentDescriptor {
  /** Stable unique identifier. Format: `<product>:<slug>` (e.g. `"forge:01-revenue"`). */
  id: string;
  /** Owning product namespace (e.g. `"forge"`, `"vauban"`, `"cc"`, `"<client-saas>"`). */
  product: string;
  /** Declared capabilities (e.g. `["content-generation", "market-analysis"]`). */
  capabilities: string[];
  /**
   * JSON Schema describing the expected input shape for this agent.
   * Callers SHOULD validate incoming payloads against this schema.
   */
  inputSchema: object;
  /** How this agent is triggered. */
  trigger: "event" | "cron" | "hitl" | "webhook";
  /** Optional LLM requirements declared by the agent. */
  llmRequirements?: {
    /** Minimum context window in tokens. */
    minContextWindow?: number;
    /** Whether the agent requires tool-use capable models. */
    toolUse?: boolean;
  };
  /** Tenant scope. When set, the descriptor is isolated to that tenant. */
  tenantId?: string;
}

// ─── AgentRegistryPort ───────────────────────────────────────────────────────

/**
 * Port interface for agent discovery. Hosts inject a concrete adapter
 * (Memory, Postgres) at boot; agents depend only on this interface.
 * @public
 */
export interface AgentRegistryPort {
  /**
   * Register an agent descriptor in the registry.
   *
   * **Upsert semantics**: if an agent with the same `id` already exists,
   * the previous record is replaced atomically. This makes `register()`
   * safe to call on every process start (auto-register pattern):
   *
   * ```ts
   * // At agent-module load time — idempotent across restarts.
   * await registry.register(myAgentDescriptor);
   * ```
   *
   * @param descriptor - The agent to register or update.
   */
  register(descriptor: AgentDescriptor): Promise<void>;

  /**
   * List all registered agents, optionally filtered by descriptor fields.
   *
   * Only top-level scalar fields are compared for filtering (`product`,
   * `trigger`, `tenantId`). Use `resolve()` for capability-based lookup.
   *
   * @param filter - Partial descriptor; only provided fields are matched.
   */
  list(filter?: Partial<AgentDescriptor>): Promise<AgentDescriptor[]>;

  /**
   * Resolve agents that declare a given capability.
   *
   * @param capability - The capability string to search for.
   * @param opts.tenantId - When provided, results are scoped to that tenant
   *   (plus global agents without a `tenantId`).
   */
  resolve(capability: string, opts?: { tenantId?: string }): Promise<AgentDescriptor[]>;

  /**
   * Remove a registered agent by id.
   *
   * Implementations MUST NOT throw if the id is not found — the operation
   * is idempotent by design.
   *
   * @param id - The agent id to remove.
   */
  unregister(id: string): Promise<void>;
}
