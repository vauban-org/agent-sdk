/**
 * HITL callback handlers — unified re-export of Slack + Telegram handlers.
 *
 * Consumers can import from this module or directly from slack.ts / telegram.ts.
 * Also provides a combined Node HTTP handler for Slack interactive payloads.
 *
 * @public
 */

export {
  createSlackCallbackHandler,
  verifySlackSignature,
  type SlackCallbackHandlerOpts,
  type RawRequest,
  type HandlerResult,
} from "./slack.js";

export {
  createTelegramCallbackHandler,
  verifyTelegramSignature,
  type TelegramCallbackHandlerOpts,
} from "./telegram.js";

export {
  collectBody,
  extractHeaders,
  parseCallbackData,
  type HITLHandlerResult,
  type HITLCallbackData,
} from "./api.js";

// ─── Node HTTP convenience adapter ──────────────────────────────────────────

import type { IncomingMessage, ServerResponse } from "node:http";
import { collectBody, extractHeaders } from "./api.js";
import { type SlackCallbackHandlerOpts, createSlackCallbackHandler } from "./slack.js";

/**
 * Create a Node.js `http.IncomingMessage` handler for Slack interactive payloads.
 *
 * Wire to: POST /slack/interactive
 * Reads the raw body (required for HMAC), verifies signature, resolves HITLPort.
 * @public
 */
export function createNodeSlackCallbackHandler(
  opts: SlackCallbackHandlerOpts,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handler = createSlackCallbackHandler(opts);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawBody = await collectBody(req);
    const headers = extractHeaders(req);

    const result = await handler({ rawBody, headers });

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  };
}
