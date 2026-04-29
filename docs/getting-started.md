# Getting started with `@vauban-org/agent-sdk`

**Version:** 0.1.0
**Status:** stable public contract (see [`CONTRACT.md`](../CONTRACT.md))

The Vauban Agent SDK is a framework for building autonomous LLM agents that
run on durable queues, respect budgets, handle HITL approvals, and emit
OpenTelemetry GenAI semantic convention spans.

It is consumed by Command Center (reference host), but distributable:
any Node 20+ app can `pnpm add @vauban-org/agent-sdk` and register its own
agents.

---

## Install

```bash
pnpm add @vauban-org/agent-sdk
```

In pnpm workspaces:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/agents/*"
```

Each agent package includes the SDK as a dep:

```json
{
  "name": "@your-org/my-agent",
  "version": "0.1.0",
  "dependencies": {
    "@vauban-org/agent-sdk": "^0.1.0"
  },
  "keywords": ["@vauban/agent-plugin"]
}
```

The `@vauban/agent-plugin` keyword makes the package auto-discoverable by
`AgentRegistry.discover()` at host boot time.

---

## Minimal echo agent

```typescript
// apps/agents/my-echo/src/index.ts
import type { AgentDescriptor } from "@vauban-org/agent-sdk";
import { createEchoHandler } from "./agent.js";

const descriptor: AgentDescriptor = {
  id: "my-echo",
  version: "0.1.0",
  loop: "minimal",          // or "sdk" for Claude Agent SDK wrapper
  budget_monthly_usd: 1,
  description: "Echoes its input back, for smoke testing.",
  handler: createEchoHandler(),
  // Optional for cron agents:
  // schedule: "0 */6 * * *",
  // featureFlag: "MY_ECHO_ENABLED",
};
export default descriptor;
```

```typescript
// apps/agents/my-echo/src/agent.ts
import type { AgentContext, AgentResult, AgentHandler } from "@vauban-org/agent-sdk";

export function createEchoHandler(): AgentHandler {
  return async (ctx: AgentContext, input: string): Promise<AgentResult> => {
    return {
      output: `Echo: ${input}`,
      stopReason: "complete",
      inputTokens: 0,
      outputTokens: 0,
    };
  };
}
```

---

## Agent primitives

The SDK exports 11 public concepts (see `CONTRACT.md` §API v0.1.0):

| Export | Role |
|--------|------|
| `AgentLoop` | Minimal loop — Anthropic SDK direct + tool registry |
| `SdkAgentLoop` | Wraps Claude Agent SDK with vauban-auth scope mapping |
| `AgentRegistry` | Plugin registration + `discover()` |
| `BudgetState` + `CoherenceDetector` | Budget tracking, stall/loop detection, compaction |
| `ProviderRouter` | Anthropic → Groq failover, quota-aware |
| `ApprovalChannel` | HITL interface + `InMemoryApprovalStore` reference impl |
| `sanitizeExternalInput` | R3-2 guardrail — length cap + injection marker regex |
| `mapScopesToSdkPermissions` | vauban-auth `cc:*` scopes → SDK bash/fileIO/web/mcp |
| `createAgentRunTracker` | Persist cost/tokens/status to `agent_run` Postgres table |
| `recordOutcome` | OTel GenAI semantic convention span |
| `createBullMQRunner` | Durable execution with DLQ + timeouts per archetype |

---

## Host setup (reference: Command Center)

```typescript
// src/durable/startup.ts
import { agentRegistry } from "@vauban-org/agent-sdk";

// At boot:
const descriptors = await agentRegistry.discover(monorepoRoot);

for (const desc of descriptors) {
  if (desc.featureFlag && process.env[desc.featureFlag] !== "true") {
    continue; // gated off
  }
  if (desc.schedule) {
    await queue.add(`${desc.id}-cron`, {}, { repeat: { pattern: desc.schedule } });
  }
}
```

That's it — the host never hardcodes agent IDs. Adding a new agent = dropping
a package with the right keyword into the workspace.

---

## External consumer example — Brain Curator

`brain-protocol` consumes the SDK to build a Brain-native curator agent
that scans recent entries and suggests `derives_from` edges:

```typescript
// brain-protocol/apps/curator/src/index.ts
import type { AgentDescriptor } from "@vauban-org/agent-sdk";
import { createCuratorHandler } from "./agent.js";

const descriptor: AgentDescriptor = {
  id: "brain-curator",
  version: "0.1.0",
  loop: "minimal",
  schedule: "0 3 * * *",  // daily 3am UTC
  featureFlag: "BRAIN_CURATOR_ENABLED",
  budget_monthly_usd: 2,
  description: "Scans recent Brain entries, suggests derives_from edges.",
  handler: createCuratorHandler(),
};
export default descriptor;
```

No coupling to Command Center — only the SDK.

---

## Versioning & stability

The SDK follows semver. See `CONTRACT.md` for the full public API signature.
Breaking changes require a major bump. Additions and internal refactors are
minor/patch.

## Publishing

Internal GHCR:

```bash
cd packages/agent-sdk
pnpm build
pnpm publish --registry https://npm.pkg.github.com
```

The `publishConfig` in `package.json` pins the registry; the user running
`publish` needs `write:packages` scope on a GitHub PAT via `.npmrc`
`//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`.

A GHA workflow (`.github/workflows/sdk-publish.yml`) automates this on
tag `sdk-v*`.
