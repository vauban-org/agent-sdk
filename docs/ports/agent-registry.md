---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Port: AgentRegistryPort

**Module:** `@vauban-org/agent-sdk` · **Since:** 0.17.0 (sprint-615:quick-5)

## Purpose

`AgentRegistryPort` enables runtime discovery of agents by capability. The orchestrator and GTM arbiter use this port to find agents without hard-coding agent IDs. SaaS clients register their own agents via `register()`.

## Interface definition

```typescript
import type {
  AgentRegistryPort,
  AgentDescriptor as AgentRegistryDescriptor,
} from "@vauban-org/agent-sdk";

interface AgentDescriptor {
  /** Format: `<product>:<slug>` — e.g. `"forge:01-revenue"` */
  id: string;
  product: string;
  capabilities: string[];
  inputSchema: object;
  trigger: "event" | "cron" | "hitl" | "webhook";
  llmRequirements?: {
    minContextWindow?: number;
    toolUse?: boolean;
  };
  tenantId?: string;
}

interface AgentRegistryPort {
  register(descriptor: AgentDescriptor): Promise<void>;
  list(filter?: Partial<AgentDescriptor>): Promise<AgentDescriptor[]>;
  resolve(capability: string, opts?: { tenantId?: string }): Promise<AgentDescriptor[]>;
  unregister(id: string): Promise<void>;
}
```

**Contract:**
- `register()` is **upsert** — safe to call on every process start
- `unregister()` is **idempotent** — does not throw if the id is absent
- `resolve()` returns agents for the capability, scoped to `tenantId` when provided (plus global agents)

## Available adapters

| Adapter | Import | Use case |
|---------|--------|---------|
| `MemoryAgentRegistry` | `@vauban-org/agent-sdk` | Tests, single-process deployments |
| `PostgresAgentRegistry` | `@vauban-org/agent-sdk` | Production, multi-tenant via RLS |

## Usage examples

### Register at boot (auto-register pattern)

```typescript
import { MemoryAgentRegistry } from "@vauban-org/agent-sdk";
import type { AgentRegistryDescriptor } from "@vauban-org/agent-sdk";

const registry = new MemoryAgentRegistry();

await registry.register({
  id: "forge:revenue-analyzer",
  product: "forge",
  capabilities: ["market-analysis", "revenue-forecast"],
  inputSchema: { type: "object", properties: { period: { type: "string" } } },
  trigger: "cron",
});
```

### Discover agents by capability

```typescript
const analysts = await registry.resolve("market-analysis");
console.log(analysts.map((a) => a.id));
// ["forge:revenue-analyzer"]

// Tenant-scoped discovery
const tenantAgents = await registry.resolve("market-analysis", { tenantId: "acme" });
```

### Via AgentFactory (auto-registration)

```typescript
import { createAgentFromConfig } from "@vauban-org/agent-sdk";

const agent = await createAgentFromConfig(deps, {
  agentId: "revenue-analyzer",
  agentVersion: "1.0.0",
  intervalMs: 300_000,
  registryDescriptor: {
    product: "forge",
    capabilities: ["market-analysis"],
    inputSchema: {},
    trigger: "cron",
  },
  phases: { /* ... */ },
});
```

When `deps.registry` and `config.registryDescriptor` are both set, `createAgentFromConfig` automatically calls `registry.register()` at boot (non-fatal — failure logs a warning but does not block start).
