/**
 * Messaging adapters — thin client-side wrappers for Telegram and Slack slash commands.
 *
 * Parses /run, /pipeline, /status commands and dispatches to AgentsClient or
 * PipelinesClient. Mirrors the server-side shape of agent-trigger-shared.ts
 * (sprint-524:quick-3) but calls REST clients instead of direct DB/execute().
 *
 * Supported commands:
 *   /run <agentId> <task description…>   → AgentsClient.execute()
 *   /pipeline <name>                     → PipelinesClient.run()
 *   /status <runId>                      → PipelinesClient.status()
 *
 * Sprint: command-center:sprint-524:quick-9
 */

import type { AgentsClient } from "./agents.js";
import type { PipelinesClient } from "./pipelines.js";

// ─── Context types ────────────────────────────────────────────────────────────

export interface TelegramTriggerContext {
  chatId: string;
  from?: { username?: string };
}

export interface SlackTriggerContext {
  userId: string;
  channelId: string;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface MessagingTriggerResult {
  replyText: string;
  runId?: string;
}

// ─── Command parser ───────────────────────────────────────────────────────────

interface ParsedCommand {
  verb: string;
  args: string[];
}

function parseCommand(command: string, args: string[]): ParsedCommand {
  // Normalise: strip leading slash if present (e.g. Telegram /run vs "run")
  const verb = command.replace(/^\//, "").toLowerCase();
  return { verb, args };
}

// ─── Shared dispatch ──────────────────────────────────────────────────────────

async function dispatch(
  agents: AgentsClient,
  pipelines: PipelinesClient,
  verb: string,
  args: string[],
): Promise<MessagingTriggerResult> {
  switch (verb) {
    case "run": {
      if (args.length < 2) {
        return {
          replyText:
            "Usage: /run <agentId> <task description>\nExample: /run ARCHITECT analyse auth flow",
        };
      }
      const agentId = args[0];
      const description = args.slice(1).join(" ");
      const result = await agents.execute({
        agentId,
        taskType: "messaging-trigger",
        description,
        archiveToBrain: false,
      });
      return {
        replyText: `Agent ${agentId} started. Status: ${result.status}\nTrack: ${result.runUrl}`,
        runId: result.runId,
      };
    }

    case "pipeline": {
      if (args.length < 1) {
        return {
          replyText:
            "Usage: /pipeline <name>\nExample: /pipeline daily-digest",
        };
      }
      const name = args[0];
      const result = await pipelines.run({ name });
      return {
        replyText: `Pipeline "${name}" queued. Run ID: ${result.runId}\nStatus: ${result.statusUrl}`,
        runId: result.runId,
      };
    }

    case "status": {
      if (args.length < 1) {
        return { replyText: "Usage: /status <runId>" };
      }
      const pipelineId = args[0];
      const result = await pipelines.status(pipelineId);
      return {
        replyText: `Run ${pipelineId}: ${result.status} (${result.progress}%)`,
        runId: pipelineId,
      };
    }

    default: {
      const known = ["/run", "/pipeline", "/status"].join(", ");
      return {
        replyText: `Unknown command: /${verb}\nAvailable: ${known}`,
      };
    }
  }
}

// ─── Telegram adapter ─────────────────────────────────────────────────────────

/**
 * Handle a Telegram message command on behalf of a bound user.
 *
 * @param agents      - AgentsClient instance (already authenticated)
 * @param pipelines   - PipelinesClient instance (already authenticated)
 * @param ctx         - Telegram context (chatId, optional username)
 * @param command     - Command verb, with or without leading "/" (e.g. "run" or "/run")
 * @param args        - Remaining tokens after the command
 */
export async function triggerFromTelegram(
  agents: AgentsClient,
  pipelines: PipelinesClient,
  ctx: TelegramTriggerContext,
  command: string,
  args: string[],
): Promise<MessagingTriggerResult> {
  const { verb, args: normalised } = parseCommand(command, args);
  try {
    return await dispatch(agents, pipelines, verb, normalised);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      replyText: `Error (chat ${ctx.chatId}): ${msg}`,
    };
  }
}

// ─── Slack adapter ────────────────────────────────────────────────────────────

/**
 * Handle a Slack slash command on behalf of a bound user.
 *
 * @param agents      - AgentsClient instance (already authenticated)
 * @param pipelines   - PipelinesClient instance (already authenticated)
 * @param ctx         - Slack context (userId, channelId)
 * @param command     - Command verb, with or without leading "/" (e.g. "run" or "/run")
 * @param args        - Remaining tokens after the command
 */
export async function triggerFromSlack(
  agents: AgentsClient,
  pipelines: PipelinesClient,
  ctx: SlackTriggerContext,
  command: string,
  args: string[],
): Promise<MessagingTriggerResult> {
  const { verb, args: normalised } = parseCommand(command, args);
  try {
    return await dispatch(agents, pipelines, verb, normalised);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      replyText: `Error (user ${ctx.userId}): ${msg}`,
    };
  }
}
