/**
 * HITL Telegram adapter — inline keyboard approval messages + HMAC-verified callback handler.
 *
 * Plan v6 §1.7: channels are transports; state lives in HITLPort (Postgres).
 * Callback_data uses compact keys (a/v) to stay within Telegram's 64-byte limit.
 *
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchJson } from "../http/fetch-json.js";
import type { HITLPort, HITLRequest } from "../ports/hitl.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Telegram channel config. */
export interface TelegramChannelConfig {
  /** Telegram Bot API token. Never hardcoded — pass at runtime. */
  botToken: string;
  /** Target chat ID (string or negative number for groups). */
  chatId: string;
}

// ─── Send approval request ───────────────────────────────────────────────────

/** @public */
export interface SendHITLTelegramOpts {
  channel: TelegramChannelConfig;
  hitlPort: HITLPort;
  request: HITLRequest;
}

/** @public */
export interface TelegramApprovalResult {
  approvalId: string;
  messageId: number;
}

const MAX_PAYLOAD_PREVIEW_BYTES = 1500;
const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Record a new HITL approval request and send an inline-keyboard message via Telegram.
 * Returns the approvalId (=request.id) and the Telegram message_id.
 * @public
 */
export async function sendHITLApprovalRequestTelegram(
  opts: SendHITLTelegramOpts,
): Promise<TelegramApprovalResult> {
  const { channel, hitlPort, request } = opts;

  // Register in HITLPort state machine (pending)
  const approvalId = await hitlPort.request(request);

  const payloadSummary = summarizePayload(request.context);
  const text = buildTelegramText({
    agentSource: request.agentSource,
    question: request.question,
    approvalId,
    payloadSummary,
    deadline: request.deadline,
  });

  // Compact keys: "a" = approval_id, "v" = action (stays within 64 bytes for short UUIDs)
  const makeButton = (label: string, action: string) => ({
    text: label,
    callback_data: JSON.stringify({ a: approvalId, v: action }),
  });

  const body = {
    chat_id: channel.chatId,
    text,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [[makeButton("✅ Approve", "approve"), makeButton("❌ Reject", "reject")]],
    },
  };

  const url = `${TELEGRAM_API_BASE}/bot${channel.botToken}/sendMessage`;
  const result = await fetchJson<{
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  }>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { label: "[hitl-telegram] Telegram API returned", bodySnippetLength: 300 },
  );

  // Telegram signals API-level failure via {ok:false} in the JSON body, even
  // on HTTP 200 — a distinct check from the HTTP-status check fetchJson does.
  if (!result.ok || !result.result) {
    throw new Error(`[hitl-telegram] Telegram API error: ${result.description ?? "unknown"}`);
  }

  return { approvalId, messageId: result.result.message_id };
}

// ─── Text builder ─────────────────────────────────────────────────────────────

interface TelegramTextOpts {
  agentSource: string;
  question: string;
  approvalId: string;
  payloadSummary: string;
  deadline: string;
}

/**
 * Build the MarkdownV2 message text for a HITL approval request.
 * Exported for snapshot testing.
 * @public
 */
export function buildTelegramText(opts: TelegramTextOpts): string {
  const { agentSource, question, approvalId, payloadSummary, deadline } = opts;
  return [
    `\u{1F6E1} *HITL Approval Required — ${escapeMd(agentSource)}*`,
    "",
    `*Agent:* ${escapeMd(agentSource)}`,
    `*Question:* ${escapeMd(question)}`,
    `*Deadline:* \`${escapeMd(deadline)}\``,
    "",
    "*Context:*",
    "```",
    escapeCodeBlock(payloadSummary.slice(0, 3000)),
    "```",
    "",
    `_${escapeMd(new Date().toISOString())} · ${escapeMd(approvalId.slice(0, 8))}_`,
  ].join("\n");
}

// ─── Callback handler ────────────────────────────────────────────────────────

export interface TelegramCallbackHandlerOpts {
  hitlPort: HITLPort;
  /** Telegram bot token — used to answer the callback query (removes loading spinner). */
  botToken: string;
  /** Optional HMAC secret for validating x-telegram-hmac-sha256 header. */
  callbackSecret?: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * Create a Telegram webhook callback handler.
 *
 * Validates optional HMAC signature, extracts callback_data (compact a/v format),
 * calls hitlPort.resolve(), then answers the Telegram callback query.
 * Idempotent: duplicate callbacks for an already-resolved request are silently ignored.
 */
export function createTelegramCallbackHandler(
  opts: TelegramCallbackHandlerOpts,
): (rawBody: string, headers: Record<string, string>) => Promise<HandlerResult> {
  const { hitlPort, botToken, callbackSecret } = opts;

  return async (rawBody: string, headers: Record<string, string>): Promise<HandlerResult> => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid json" } };
    }

    // Optional HMAC signature check
    if (callbackSecret) {
      const sig = headers["x-telegram-hmac-sha256"];
      if (!sig) {
        return { status: 401, body: { ok: false, error: "missing signature" } };
      }
      if (!verifyTelegramSignature(rawBody, sig, callbackSecret)) {
        return {
          status: 401,
          body: { ok: false, error: "invalid signature" },
        };
      }
    }

    // Only handle callback_query updates (button clicks)
    const callbackQuery = payload.callback_query as Record<string, unknown> | undefined;
    if (!callbackQuery?.data) {
      return { status: 200, body: { ok: true } };
    }

    let callbackData: {
      a?: unknown;
      v?: unknown;
      approval_id?: unknown;
      action?: unknown;
    };
    try {
      callbackData = JSON.parse(callbackQuery.data as string) as typeof callbackData;
    } catch {
      return {
        status: 400,
        body: { ok: false, error: "invalid callback_data" },
      };
    }

    // Support compact (a/v) and legacy (approval_id/action) formats
    const approvalId = String(callbackData.a ?? callbackData.approval_id ?? "");
    const actionRaw = String(callbackData.v ?? callbackData.action ?? "");

    if (!approvalId || !actionRaw) {
      return {
        status: 400,
        body: { ok: false, error: "missing approval_id or action" },
      };
    }

    const decision = actionRaw === "approve" ? "approved" : "rejected";

    let resolved = true;
    try {
      await hitlPort.resolve(approvalId, decision, "telegram");
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "InvalidStateTransitionError" || err.name === "HITLNotFoundError")
      ) {
        resolved = false;
      } else {
        throw err;
      }
    }

    // Answer the callback query (removes Telegram's loading spinner)
    const callbackQueryId = String(callbackQuery.id ?? "");
    if (callbackQueryId) {
      const answerUrl = `${TELEGRAM_API_BASE}/bot${botToken}/answerCallbackQuery`;
      await fetch(answerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: resolved
            ? `${decision === "approved" ? "✅" : "❌"} Action ${decision}`
            : "⚠️ Already resolved or not found",
          show_alert: true,
        }),
      }).catch(() => {
        // Best-effort — don't fail the handler if Telegram API is slow
      });
    }

    return { status: 200, body: { ok: true } };
  };
}

// ─── HMAC verification ───────────────────────────────────────────────────────

/**
 * Verify the x-telegram-hmac-sha256 header using HMAC-SHA256 of the raw body.
 *
 * @public — exported for unit tests
 */
export function verifyTelegramSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const computed = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

// ─── Plain message helper ─────────────────────────────────────────────────────

/**
 * Send a plain informational message to a Telegram chat (no buttons).
 * Used for daily briefs and non-interactive notifications.
 */
export async function sendTelegramMessage(
  text: string,
  channel: TelegramChannelConfig,
): Promise<void> {
  if (!channel.botToken || !channel.chatId) return;
  const url = `${TELEGRAM_API_BASE}/bot${channel.botToken}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channel.chatId,
      text: text.slice(0, 4096),
      parse_mode: "Markdown",
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    // Best-effort non-interactive message — swallow errors
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[hitl-telegram] sendMessage failed: ${msg}\n`);
  });
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function summarizePayload(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(raw, "utf-8") <= MAX_PAYLOAD_PREVIEW_BYTES) return raw;
  return `${raw.slice(0, MAX_PAYLOAD_PREVIEW_BYTES - 50)}\n... [truncated]`;
}

function escapeMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function escapeCodeBlock(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}
