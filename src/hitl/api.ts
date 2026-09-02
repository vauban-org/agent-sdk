/**
 * HITL HTTP API helpers — framework-agnostic request body reader and
 * shared types used by both Slack and Telegram callback handlers.
 *
 * Plan v6 §1.7: state lives in HITLPort; this module is pure transport plumbing.
 *
 * @public
 */

import type { IncomingMessage } from "node:http";

// ─── Shared handler result type ──────────────────────────────────────────────

/**
 * Framework-agnostic result returned by all HITL callback handlers.
 * @public
 */
export interface HITLHandlerResult {
  status: number;
  body: unknown;
}

// ─── Raw request adapter for Node HTTP ──────────────────────────────────────

/**
 * Read the full body from a Node.js `IncomingMessage` stream.
 * Returns the raw UTF-8 string (required for HMAC verification).
 */
export function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Extract all headers from a Node `IncomingMessage` as a flat string map.
 * Multi-value headers are joined with `, `.
 */
export function extractHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    out[key] = Array.isArray(val) ? val.join(", ") : val;
  }
  return out;
}

// ─── Common button-value parsing ────────────────────────────────────────────

/**
 * Compact callback_data format used by both Slack (button value) and Telegram.
 * @public
 */
export interface HITLCallbackData {
  approvalId: string;
  action: "approve" | "reject";
}

/**
 * Parse a HITL button value that may use either:
 * - compact format: `{ a: "<id>", v: "approve"|"reject" }`
 * - legacy format:  `{ approval_id: "<id>", action: "approve"|"reject" }`
 *
 * Returns null on any parsing failure.
 */
export function parseCallbackData(raw: string): HITLCallbackData | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const approvalId = String(parsed.a ?? parsed.approval_id ?? "");
  const actionRaw = String(parsed.v ?? parsed.action ?? "");

  if (!approvalId) return null;
  if (actionRaw !== "approve" && actionRaw !== "reject") return null;

  return { approvalId, action: actionRaw };
}
