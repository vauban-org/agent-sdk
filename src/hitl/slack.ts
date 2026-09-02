/**
 * HITL Slack adapter — Block Kit approval messages + HMAC-verified callback handler.
 *
 * Plan v6 §1.7: channels are transports; state lives in HITLPort (Postgres).
 * HMAC-SHA256 verification uses Slack signing secret (replay window: 5 min).
 *
 * @public
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchOrThrow } from "../http/fetch-json.js";
import type { HITLPort, HITLRequest } from "../ports/hitl.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Slack channel config — webhook URL only (no bot token). */
export interface SlackChannelConfig {
  /** Slack Incoming Webhook URL. Never hardcoded — pass at runtime. */
  webhookUrl: string;
}

// ─── Send approval request ───────────────────────────────────────────────────

/** @public */
export interface SendHITLSlackOpts {
  channel: SlackChannelConfig;
  hitlPort: HITLPort;
  request: HITLRequest;
  /** Optional cost in USD for the Block Kit display. */
  costDisplayUsd?: number;
}

/** @public */
export interface SlackApprovalResult {
  approvalId: string;
  messageTs: string;
}

const MAX_PAYLOAD_PREVIEW_BYTES = 1500;

/**
 * Record a new HITL approval request and post a Block Kit message to Slack.
 * Returns the approvalId (=request.id) and the Slack message timestamp.
 * @public
 */
export async function sendHITLApprovalRequestSlack(
  opts: SendHITLSlackOpts,
): Promise<SlackApprovalResult> {
  const { channel, hitlPort, request, costDisplayUsd } = opts;

  // Register in HITLPort state machine (pending)
  const approvalId = await hitlPort.request(request);

  const costDisplay = costDisplayUsd != null ? `$${costDisplayUsd.toFixed(2)}` : "unknown";
  const payloadSummary = summarizePayload(request.context);

  const blocks = buildBlockKit({
    agentSource: request.agentSource,
    question: request.question,
    approvalId,
    costDisplay,
    payloadSummary,
    deadline: request.deadline,
  });

  await fetchOrThrow(
    channel.webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks }),
    },
    { label: "[hitl-slack] Slack webhook returned", bodySnippetLength: 300 },
  );

  // Incoming webhooks don't return a timestamp — use ISO time as placeholder
  const messageTs = String(Date.now());
  return { approvalId, messageTs };
}

// ─── Block Kit builder ───────────────────────────────────────────────────────

interface BlockKitOpts {
  agentSource: string;
  question: string;
  approvalId: string;
  costDisplay: string;
  payloadSummary: string;
  deadline: string;
}

/**
 * Build a Slack Block Kit structure for HITL approval.
 * Exported for snapshot testing.
 * @public
 */
export function buildBlockKit(opts: BlockKitOpts): unknown[] {
  const { agentSource, question, approvalId, costDisplay, payloadSummary, deadline } = opts;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `:shield: HITL Approval Required — ${agentSource}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Agent:*\n${agentSource}` },
        { type: "mrkdwn", text: `*Question:*\n${question}` },
        { type: "mrkdwn", text: `*Cost:*\n${costDisplay}` },
        { type: "mrkdwn", text: `*Deadline:*\n\`${deadline}\`` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Context:*\n\`\`\`${payloadSummary}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:clock1: ${new Date().toISOString()} · Approval ID: \`${truncate(
            approvalId,
            8,
          )}\``,
        },
      ],
    },
    {
      type: "actions",
      block_id: `hitl_${approvalId.slice(0, 8)}`,
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: ":white_check_mark: Approve",
            emoji: true,
          },
          style: "primary",
          value: JSON.stringify({ approval_id: approvalId, action: "approve" }),
          action_id: "hitl_approve",
        },
        {
          type: "button",
          text: { type: "plain_text", text: ":x: Reject", emoji: true },
          style: "danger",
          value: JSON.stringify({ approval_id: approvalId, action: "reject" }),
          action_id: "hitl_reject",
        },
      ],
    },
  ];
}

// ─── Callback handler ────────────────────────────────────────────────────────

export interface SlackCallbackHandlerOpts {
  hitlPort: HITLPort;
  /** Slack signing secret. Never hardcoded — pass at runtime. */
  signingSecret: string;
}

/** Raw HTTP request shape — agnostic of HTTP framework. */
export interface RawRequest {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * Create a Slack interactive-payload callback handler.
 *
 * Wire to: POST /slack/interactive
 * Verifies HMAC-SHA256 signature, parses payload, calls hitlPort.resolve().
 * Idempotent: duplicate payloads for the same approvalId are silently ignored
 * (HITLPort throws InvalidStateTransitionError on non-pending → we swallow it).
 */
export function createSlackCallbackHandler(
  opts: SlackCallbackHandlerOpts,
): (req: RawRequest) => Promise<HandlerResult> {
  const { hitlPort, signingSecret } = opts;

  return async (req: RawRequest): Promise<HandlerResult> => {
    const timestamp = headerString(req.headers["x-slack-request-timestamp"]);
    const signature = headerString(req.headers["x-slack-signature"]);

    if (!verifySlackSignature(req.rawBody, timestamp, signature, signingSecret)) {
      return { status: 401, body: { ok: false, error: "invalid signature" } };
    }

    // Slack wraps the JSON payload in a form-encoded "payload" field
    const parsed = parseFormEncoded(req.rawBody);
    const wrapped = parsed.payload;
    if (!wrapped) {
      return {
        status: 400,
        body: { ok: false, error: "missing payload field" },
      };
    }

    let interaction: { actions?: Array<{ value?: string }> };
    try {
      interaction = JSON.parse(wrapped) as typeof interaction;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid JSON" } };
    }

    const actionBlock = interaction.actions?.[0];
    if (!actionBlock?.value) {
      return {
        status: 400,
        body: { ok: false, error: "no action value" },
      };
    }

    const buttonVal = parseButtonValue(actionBlock.value);
    if (!buttonVal) {
      return {
        status: 400,
        body: { ok: false, error: "invalid button value" },
      };
    }

    const { approvalId, action } = buttonVal;
    const decision = action === "approve" ? "approved" : "rejected";

    try {
      await hitlPort.resolve(approvalId, decision, "slack");
    } catch (err) {
      // Idempotence: already resolved → silently accept
      if (
        err instanceof Error &&
        (err.name === "InvalidStateTransitionError" || err.name === "HITLNotFoundError")
      ) {
        return {
          status: 200,
          body: { ok: true, note: "already resolved" },
        };
      }
      throw err;
    }

    return {
      status: 200,
      body: { text: `Action ${action}d for ${approvalId}` },
    };
  };
}

// ─── HMAC verification ───────────────────────────────────────────────────────

/**
 * Verify the X-Slack-Signature header using HMAC-SHA256.
 * Signature format: `v0=<hex>` over `v0:{timestamp}:{rawBody}`.
 * Rejects timestamps older than 5 minutes (replay protection).
 *
 * @public — exported for unit tests
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): boolean {
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(age) || age > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(computed, "utf-8"), Buffer.from(signature, "utf-8"));
  } catch {
    return false;
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function parseButtonValue(
  value: string,
): { approvalId: string; action: "approve" | "reject" } | null {
  try {
    const parsed = JSON.parse(value) as {
      approval_id?: unknown;
      action?: unknown;
    };
    if (
      typeof parsed.approval_id === "string" &&
      parsed.approval_id.length > 0 &&
      (parsed.action === "approve" || parsed.action === "reject")
    ) {
      return { approvalId: parsed.approval_id, action: parsed.action };
    }
    return null;
  } catch {
    return null;
  }
}

function parseFormEncoded(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

function headerString(h: string | string[] | undefined): string {
  if (!h) return "";
  return Array.isArray(h) ? (h[0] ?? "") : h;
}

function summarizePayload(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(raw, "utf-8") <= MAX_PAYLOAD_PREVIEW_BYTES) return raw;
  return `${raw.slice(0, MAX_PAYLOAD_PREVIEW_BYTES - 50)}\n... [truncated]`;
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}
