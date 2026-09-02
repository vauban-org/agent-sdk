/**
 * remote/gateway/render — turn a SessionEvent into chat-surface text.
 *
 * A chat platform wants milestones, not a token firehose. Noisy events
 * (`TEXT_MESSAGE_CONTENT`, `STEP_STARTED`, `STATE_SNAPSHOT`, raw
 * `TOOL_CALL_START`) are always dropped; `tool.*` detail renders only in
 * verbose mode. The result is a short, human-readable line — or `null` to
 * skip the event entirely.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

import type { SessionEvent } from "../events.js";
import { unexecutedToolCallWarning } from "./unexecuted-tool-call.js";

export interface RenderOptions {
  /** Render CUSTOM_TOOL_INTENT + TOOL_CALL_END too (chattier). Default false. */
  verbose?: boolean;
  /**
   * Max characters per rendered chunk. Default 3500 — under Telegram's 4096
   * hard limit. Platform adapters truncate further if their limit is lower
   * (Discord caps at 2000).
   */
  maxChars?: number;
}

const DEFAULT_MAX = 3500;

/** Clip `s` to `max` characters with an ellipsis marker. */
export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Render one SessionEvent as human-readable chat text — or `null` to skip.
 * Handles both canonical AG-UI UPPER_SNAKE_CASE types (3.0.0+) and legacy
 * dotted-lowercase types emitted before 3.0.0 for replay compatibility.
 * @public
 */
export function renderEventForChat(event: SessionEvent, opts: RenderOptions = {}): string | null {
  const max = opts.maxChars ?? DEFAULT_MAX;
  const verbose = opts.verbose ?? false;

  switch (event.type) {
    // ─── Canonical AG-UI types (primary — hub emits these since 3.0.0) ──────
    case "RUN_STARTED":
    case "run.start":
      return (event.data as { task?: string }).task
        ? `▶️ run started — ${truncate((event.data as { task: string }).task, 200)}`
        : "▶️ run started";

    case "TEXT_MESSAGE_END":
    case "assistant.message": {
      const c = (event.data as { content: string }).content.trim();
      if (c === "") return null;
      // Un appel d'outil ECRIT au lieu d'etre emis n'est pas une reponse : le
      // modele en deduit ensuite un resultat qu'il n'a jamais obtenu. On annote
      // plutot que de supprimer -- voir `unexecuted-tool-call.ts` pour le cas
      // reel du 2026-08-30 qui a motive cette garde.
      const warning = unexecutedToolCallWarning(c);
      return warning === null
        ? truncate(c, max)
        : `${warning}\n\n${truncate(c, Math.max(0, max - warning.length - 2))}`;
    }

    case "CUSTOM_TOOL_INTENT":
    case "tool.intent":
      return verbose
        ? `🛠️ intends ${(event.data as { toolName: string }).toolName}(${truncate(
            (event.data as { argsPreview: string }).argsPreview,
            160,
          )})`
        : null;

    case "TOOL_CALL_END":
    case "tool.call.end":
      return verbose
        ? `${(event.data as { ok: boolean }).ok ? "✓" : "✗"} ${
            (event.data as { toolName: string }).toolName
          } — ${truncate((event.data as { resultPreview: string }).resultPreview, 200)}`
        : null;

    case "CUSTOM_HITL_REQUEST":
    case "hitl.request": {
      const rawCtx = (event.data as { context: string }).context;
      // Empty-arg tools serialize their args to "{}"; showing that to the
      // founder is a blind approval. Render a readable placeholder instead.
      const ctx =
        !rawCtx || rawCtx === "{}" || rawCtx === '""'
          ? "(no extra arguments; approve to run this action)"
          : truncate(rawCtx, 400);
      return `⚠️ approval needed: ${truncate(
        (event.data as { action: string }).action,
        200,
      )}\n${ctx}\nreply /approve or /reject`;
    }

    case "CUSTOM_HITL_RESOLVED":
    case "hitl.resolved":
      return `${
        (event.data as { approved: boolean }).approved ? "✅ approved" : "🛑 rejected"
      } by ${(event.data as { by: string }).by}`;

    case "CUSTOM_INSTRUCTION_INJECTED":
    case "instruction.injected":
      // A whisper is out-of-band by design — do not echo it back to chat.
      return (event.data as { whisper: boolean }).whisper
        ? null
        : `📨 instruction received: ${truncate((event.data as { text: string }).text, 200)}`;

    case "CUSTOM_TEAMMATE_DELIVERY": {
      // Metadata sidecar ; the delivered text itself already rendered via the
      // paired CUSTOM_INSTRUCTION_INJECTED event above; only surface the
      // origin in verbose mode to avoid double-printing the same delivery.
      if (!verbose) return null;
      const d = event.data as {
        claimKind: string;
        fromRunId: string;
        fromInstallId?: string;
        capability?: string;
        replyTo?: string;
      };
      const origin = d.fromInstallId ? `${d.fromInstallId}/${d.fromRunId}` : d.fromRunId;
      const cap = d.capability ? `:${d.capability}` : "";
      // sprint-1067 T3 ; a delivery carrying `replyTo` closes an ask this
      // session sent : name it as the answer it is.
      if (d.replyTo !== undefined) return `🤝 teammate reply from ${origin}`;
      return `🤝 teammate ${d.claimKind}${cap} from ${origin}`;
    }

    case "RUN_FINISHED":
    case "run.finished":
      return `⏹️ run finished (${
        (event.data as { stopReason: string }).stopReason
      }) — ${(event.data as { stepCount: number }).stepCount} steps, $${(event.data as { costUsd: number }).costUsd.toFixed(4)}`;

    default:
      // TEXT_MESSAGE_CONTENT, STEP_STARTED, TOOL_CALL_START, STATE_SNAPSHOT
      // (and their legacy peers) — too noisy for chat.
      return null;
  }
}
