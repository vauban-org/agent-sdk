/**
 * PostgresAgentRegistry — persistent adapter for AgentRegistryPort.
 *
 * Requires the `agent_registry` table (migration 039_agent_registry_port.sql).
 * Uses RLS for tenant isolation — call `resolve()` with `tenantId` to scope
 * queries via `set_config('app.tenant_id', ...)`.
 *
 * Depends on `DbPort` (compatible with `pg.Pool` / `pg.Client`).
 */

import type { AgentDescriptor, AgentRegistryPort } from "../../ports/agent-registry.js";
import type { DbPort } from "../../ports/db.js";

// ─── Row shape returned by Postgres ──────────────────────────────────────────

interface AgentRegistryRow {
  id: string;
  product: string;
  capabilities: string[];
  input_schema: object;
  trigger: "event" | "cron" | "hitl" | "webhook";
  llm_requirements: { minContextWindow?: number; toolUse?: boolean } | null;
  tenant_id: string | null;
  last_seen: Date | null;
}

function rowToDescriptor(row: AgentRegistryRow): AgentDescriptor {
  const d: AgentDescriptor = {
    id: row.id,
    product: row.product,
    capabilities: row.capabilities,
    inputSchema: row.input_schema,
    trigger: row.trigger,
  };
  if (row.llm_requirements !== null) {
    d.llmRequirements = row.llm_requirements;
  }
  if (row.tenant_id !== null) {
    d.tenantId = row.tenant_id;
  }
  return d;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/** @public */
export class PostgresAgentRegistry implements AgentRegistryPort {
  constructor(private readonly db: DbPort) {}

  /**
   * Register (upsert) an agent descriptor using INSERT … ON CONFLICT DO UPDATE.
   * Safe to call on every process start (auto-register pattern).
   */
  async register(descriptor: AgentDescriptor): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_registry
         (id, product, capabilities, input_schema, trigger, llm_requirements, tenant_id, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         product          = EXCLUDED.product,
         capabilities     = EXCLUDED.capabilities,
         input_schema     = EXCLUDED.input_schema,
         trigger          = EXCLUDED.trigger,
         llm_requirements = EXCLUDED.llm_requirements,
         tenant_id        = EXCLUDED.tenant_id,
         updated_at       = NOW(),
         last_seen        = NOW()`,
      [
        descriptor.id,
        descriptor.product,
        descriptor.capabilities,
        JSON.stringify(descriptor.inputSchema),
        descriptor.trigger,
        descriptor.llmRequirements !== undefined
          ? JSON.stringify(descriptor.llmRequirements)
          : null,
        descriptor.tenantId ?? null,
      ],
    );
  }

  /**
   * List agents, optionally filtered by scalar descriptor fields.
   */
  async list(filter?: Partial<AgentDescriptor>): Promise<AgentDescriptor[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.id !== undefined) {
      params.push(filter.id);
      conditions.push(`id = $${params.length}`);
    }
    if (filter?.product !== undefined) {
      params.push(filter.product);
      conditions.push(`product = $${params.length}`);
    }
    if (filter?.trigger !== undefined) {
      params.push(filter.trigger);
      conditions.push(`trigger = $${params.length}`);
    }
    if (filter?.tenantId !== undefined) {
      params.push(filter.tenantId);
      conditions.push(`tenant_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await this.db.query<AgentRegistryRow>(
      `SELECT id, product, capabilities, input_schema, trigger,
              llm_requirements, tenant_id, last_seen
       FROM agent_registry
       ${where}
       ORDER BY id`,
      params,
    );

    return result.rows.map(rowToDescriptor);
  }

  /**
   * Resolve agents that declare the given capability.
   *
   * When `opts.tenantId` is provided, `set_config` injects the tenant id so
   * that Postgres RLS policy `tenant_isolation` applies. The query also
   * returns global agents (tenant_id IS NULL) alongside tenant-scoped ones.
   */
  async resolve(capability: string, opts?: { tenantId?: string }): Promise<AgentDescriptor[]> {
    if (opts?.tenantId !== undefined) {
      // Set tenant context for RLS; true = local to transaction
      await this.db.query(`SELECT set_config('app.tenant_id', $1, true)`, [opts.tenantId]);
    }

    const params: unknown[] = [capability];
    let tenantClause = "";

    if (opts?.tenantId !== undefined) {
      params.push(opts.tenantId);
      tenantClause = `AND (tenant_id IS NULL OR tenant_id = $${params.length})`;
    }

    const result = await this.db.query<AgentRegistryRow>(
      `SELECT id, product, capabilities, input_schema, trigger,
              llm_requirements, tenant_id, last_seen
       FROM agent_registry
       WHERE capabilities @> ARRAY[$1::text]
       ${tenantClause}
       ORDER BY id`,
      params,
    );

    return result.rows.map(rowToDescriptor);
  }

  /**
   * Remove an agent by id. No-op if the id does not exist.
   */
  async unregister(id: string): Promise<void> {
    await this.db.query("DELETE FROM agent_registry WHERE id = $1", [id]);
  }
}
