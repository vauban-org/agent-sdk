/**
 * MemoryAgentRegistry — in-process adapter for AgentRegistryPort.
 *
 * Zero dependencies. Suitable for unit tests, single-process deployments,
 * and as a local cache in front of PostgresAgentRegistry.
 *
 * Thread safety: not applicable (Node.js single-threaded event loop).
 * Persistence: none — state is lost on process restart.
 */

import type { AgentDescriptor, AgentRegistryPort } from "../../ports/agent-registry.js";

/** @public */
export class MemoryAgentRegistry implements AgentRegistryPort {
  private readonly store = new Map<string, AgentDescriptor>();

  /**
   * Register (upsert) an agent descriptor.
   * Overwrites any existing descriptor with the same `id`.
   */
  async register(descriptor: AgentDescriptor): Promise<void> {
    this.store.set(descriptor.id, { ...descriptor });
  }

  /**
   * List agents, optionally narrowed by a partial descriptor filter.
   *
   * Only scalar top-level fields are compared (`product`, `trigger`,
   * `tenantId`). Arrays (`capabilities`) are not compared here — use
   * `resolve()` for capability-based lookup.
   */
  async list(filter?: Partial<AgentDescriptor>): Promise<AgentDescriptor[]> {
    const all = Array.from(this.store.values());
    if (!filter) return all.map((d) => ({ ...d }));

    return all
      .filter((d) => {
        if (filter.id !== undefined && d.id !== filter.id) return false;
        if (filter.product !== undefined && d.product !== filter.product) return false;
        if (filter.trigger !== undefined && d.trigger !== filter.trigger) return false;
        if (filter.tenantId !== undefined && d.tenantId !== filter.tenantId) return false;
        return true;
      })
      .map((d) => ({ ...d }));
  }

  /**
   * Resolve agents that declare the given capability.
   *
   * When `opts.tenantId` is provided, only agents whose `tenantId` matches
   * OR whose `tenantId` is undefined (global agents) are returned.
   */
  async resolve(capability: string, opts?: { tenantId?: string }): Promise<AgentDescriptor[]> {
    const results: AgentDescriptor[] = [];

    for (const d of this.store.values()) {
      if (!d.capabilities.includes(capability)) continue;

      if (opts?.tenantId !== undefined) {
        // Include only the exact tenant + global agents
        if (d.tenantId !== undefined && d.tenantId !== opts.tenantId) continue;
      }

      results.push({ ...d });
    }

    return results;
  }

  /**
   * Remove an agent by id. No-op if the id is not registered.
   */
  async unregister(id: string): Promise<void> {
    this.store.delete(id);
  }
}
