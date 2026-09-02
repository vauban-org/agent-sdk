---
classification: C2
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Port: MessagingChannelPort

**Module:** `@vauban-org/agent-sdk` · **Since:** 0.16.0 (sprint-615:quick-2)

## Purpose

`MessagingChannelPort` is the generic abstraction for sending alerts and free-form messages via any channel (Telegram, Slack, Discord, console, or MCP). HITL approval flows are **excluded** from this port — they belong to `HITLPort` (plan v6 §3.5).

Agents depend on this port for operational notifications; the concrete adapter is injected at boot via `AgentFactoryDeps.messaging`.

## Interface definition

```typescript
import type { MessagingChannelPort, AlertLevel } from "@vauban-org/agent-sdk";
import { InvalidTargetError } from "@vauban-org/agent-sdk";

type AlertLevel = "info" | "warn" | "error" | "critical";

interface MessagingChannelPort {
  sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;
  sendMessage(target: string, text: string): Promise<void>;
}

class InvalidTargetError extends Error {
  readonly target: string;
  constructor(message: string, target: string);
}
```

`sendMessage()` throws `InvalidTargetError` when `target` is empty or structurally invalid for the adapter.

## Available adapters

| Adapter | Import | Notes |
|---------|--------|-------|
| `ConsoleChannel` | `@vauban-org/agent-sdk` | Dev/test, prints to stdout |
| `TelegramChannel` | `@vauban-org/agent-sdk` | Requires bot token + chat ID |
| `SlackChannel` | `@vauban-org/agent-sdk` | Requires webhook URL or Bot token |
| `DiscordChannel` | `@vauban-org/agent-sdk` | Requires webhook URL |
| `MCPChannel` | `@vauban-org/agent-sdk` | For MCP-based environments |

## Adapter examples

### ConsoleChannel (dev/test)

```typescript
import { ConsoleChannel } from "@vauban-org/agent-sdk";
import type { ConsoleChannelConfig } from "@vauban-org/agent-sdk";

const messaging = new ConsoleChannel({ prefix: "[my-agent]" } satisfies ConsoleChannelConfig);
await messaging.sendAlert("warn", "High latency", "p99 = 350ms");
```

### TelegramChannel

```typescript
import { TelegramChannel } from "@vauban-org/agent-sdk";
import type { TelegramChannelConfig } from "@vauban-org/agent-sdk";

const messaging = new TelegramChannel({
  botToken: process.env["TELEGRAM_BOT_TOKEN"]!,
  defaultChatId: process.env["TELEGRAM_CHAT_ID"]!,
} satisfies TelegramChannelConfig);

await messaging.sendAlert("critical", "Vault breach detected", "Immediate action required");
await messaging.sendMessage("-100123456", "Custom message to a specific chat");
```

### SlackChannel

```typescript
import { SlackChannel } from "@vauban-org/agent-sdk";
import type { SlackChannelConfig } from "@vauban-org/agent-sdk";

const messaging = new SlackChannel({
  webhookUrl: process.env["SLACK_WEBHOOK_URL"]!,
} satisfies SlackChannelConfig);

await messaging.sendAlert("error", "Pipeline failed", "Incident ID: inc-42");
```

## Usage in an agent

```typescript
import { createSimpleAgent, ConsoleChannel } from "@vauban-org/agent-sdk";
import type { AgentFactoryDeps } from "@vauban-org/agent-sdk";

const deps: Partial<AgentFactoryDeps> = {
  messaging: new ConsoleChannel(),
  // ... other deps
};
```

When `deps.messaging` is set, `AgentFactory` automatically wires HITL notifications through it for agents with `hitlEscalationLevel` configured.
