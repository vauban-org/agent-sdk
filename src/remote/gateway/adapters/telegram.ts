/**
 * remote/gateway/adapters/telegram — Telegram Bot API gateway adapter.
 *
 * Inbound: long-polling `getUpdates` — no inbound port, the same dial-out
 * posture as the sovereign relay. Outbound: `sendMessage` with HTML formatting.
 *
 * Zero-trust: `allowedChatIds` MUST be non-empty. It is BOTH the allowlist of
 * chats permitted to drive the agent AND the set of delivery targets — a
 * stranger who discovers the bot can neither control nor observe the session.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

import type {
  ApprovalCallback,
  ApprovalPrompt,
  GatewayAdapter,
  GatewayLogger,
  InboundMessage,
} from "../types.js";
import { NOOP_LOGGER } from "../types.js";

/** Telegram message text hard limit (applies to HTML source too). */
const TELEGRAM_MAX_CHARS = 4096;

// ─── Markdown-to-Telegram-HTML converter ─────────────────────────────────────
//
// Telegram only supports a strict subset of HTML tags:
//   b, i, u, s, a, code, pre, blockquote, tg-spoiler
// No new npm dependency — self-contained, tested, < 100 LOC.

/** Escape the three characters that break Telegram HTML entity parsing. */
function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert GitHub-flavoured markdown to Telegram-safe HTML.
 *
 * Processing order:
 *  1. Extract and protect fenced + inline code spans (replace with placeholders
 *     so inner content is never transformed by later passes).
 *  2. Escape `&`, `<`, `>` in all non-code segments.
 *  3. Apply inline formatting: bold, italic, strikethrough, links.
 *  4. Convert block-level constructs: headers -> bold, bullets -> Unicode dot.
 *  5. Restore code placeholders with their final HTML tags.
 *
 * @exported for unit testing
 */
export function markdownToTelegramHtml(md: string): string {
  // ── Step 1: extract code spans / fenced blocks into a placeholder table ──
  const codeParts: string[] = [];
  const placeholder = (idx: number): string => `\x00CODE${idx}\x00`;

  // Fenced code blocks: ```lang\ncode\n```
  let work = md.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match: string, lang: string, body: string): string => {
      const escapedBody = escapeHtml(body.replace(/\n$/, ""));
      const trimmedLang = lang.trim();
      const html =
        trimmedLang.length > 0
          ? `<pre><code class="language-${escapeHtml(trimmedLang)}">${escapedBody}</code></pre>`
          : `<pre>${escapedBody}</pre>`;
      const idx = codeParts.length;
      codeParts.push(html);
      return placeholder(idx);
    },
  );

  // Inline code: `code`
  work = work.replace(/`([^`\n]+)`/g, (_match: string, body: string): string => {
    const idx = codeParts.length;
    codeParts.push(`<code>${escapeHtml(body)}</code>`);
    return placeholder(idx);
  });

  // ── Step 2: escape HTML-special chars in all non-code text ───────────────
  // Split around placeholders so we only escape real text segments.
  work = work
    // biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 sentinel delimits code placeholders.
    .split(/(\x00CODE\d+\x00)/)
    .map((seg: string): string => (seg.startsWith("\x00CODE") ? seg : escapeHtml(seg)))
    .join("");

  // ── Step 3: inline formatting ─────────────────────────────────────────────
  // Bold: **x** or __x__
  work = work.replace(
    /\*\*(.+?)\*\*|__(.+?)__/g,
    (_m, a: string | undefined, b: string | undefined): string => `<b>${a ?? b ?? ""}</b>`,
  );

  // Italic: *x* or _x_ (single, not double)
  // Use negative look-behind/ahead to avoid matching inside words for underscore form.
  work = work.replace(/\*([^*\n]+?)\*/g, (_m, a: string): string => `<i>${a}</i>`);
  work = work.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, (_m, a: string): string => `<i>${a}</i>`);

  // Strikethrough: ~~x~~
  work = work.replace(/~~(.+?)~~/g, (_m, a: string): string => `<s>${a}</s>`);

  // Links: [text](url) — only http/https to avoid javascript: injection
  work = work.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, text: string, url: string): string => `<a href="${url}">${text}</a>`,
  );

  // ── Step 4: block-level constructs ────────────────────────────────────────
  work = work
    .split("\n")
    .map((line: string): string => {
      // Headers: # / ## / ### -> bold line
      const hMatch = /^(#{1,3})\s+(.*)$/.exec(line);
      if (hMatch) return `<b>${hMatch[2] ?? ""}</b>`;

      // Bullet lists: - or * at line start -> Unicode bullet
      const bMatch = /^(\s*)[*-]\s+(.*)$/.exec(line);
      if (bMatch) return `${bMatch[1] ?? ""}• ${bMatch[2] ?? ""}`;

      return line;
    })
    .join("\n");

  // ── Step 5: restore code placeholders ────────────────────────────────────
  work = work.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 sentinel delimits code placeholders.
    /\x00CODE(\d+)\x00/g,
    (_m: string, idx: string): string => codeParts[Number(idx)] ?? "",
  );

  return work;
}

/**
 * Strip all markdown / HTML to produce a readable plain-text fallback.
 * Used when Telegram rejects the HTML payload (API 400 "can't parse entities").
 */
function markdownToPlainText(md: string): string {
  return (
    md
      // Fenced code blocks: keep content
      .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m: string, body: string): string => body.trim())
      // Inline code: keep content
      .replace(/`([^`\n]+)`/g, (_m: string, body: string): string => body)
      // Bold / italic markers
      .replace(/\*\*(.+?)\*\*/g, (_m: string, a: string): string => a)
      .replace(/__(.+?)__/g, (_m: string, a: string): string => a)
      .replace(/\*([^*\n]+?)\*/g, (_m: string, a: string): string => a)
      .replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, (_m: string, a: string): string => a)
      // Strikethrough
      .replace(/~~(.+?)~~/g, (_m: string, a: string): string => a)
      // Links: keep text only
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, (_m: string, text: string): string => text)
      // Headers: keep text
      .replace(/^#{1,3}\s+(.*)$/gm, (_m: string, text: string): string => text)
  );
}

/**
 * Split a string into chunks of at most `maxLen` characters, breaking on
 * paragraph boundaries (\n\n) then line boundaries (\n) when possible.
 * Never breaks inside a `<pre>` block or an HTML tag.
 */
function splitIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Look for the last paragraph break within the limit
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen; // hard cut — no safe boundary found
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Telegram caps `callback_data` at 64 BYTES. A HITL request id is a UUID (36
 * chars) and the prefix + verdict tag would still fit, but ids are not
 * contractually bounded ; a future longer id would silently overflow and
 * Telegram would reject the whole keyboard. So we never put the raw id on the
 * wire: each button carries a short opaque token, and the adapter maps the
 * token back to the real id locally. `apv:<token>:<a|r>` stays well under 64 B.
 */
const CALLBACK_PREFIX = "apv";

export interface TelegramAdapterOptions {
  /** Bot token from @BotFather. */
  botToken: string;
  /**
   * Allowlist of Telegram chat ids permitted to control the agent AND the
   * delivery targets for its output. MUST be non-empty.
   */
  allowedChatIds: string[];
  /** Injected fetch — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Long-poll timeout in seconds. Default 25. */
  pollTimeoutSec?: number;
  /** API base — override for tests. Default https://api.telegram.org. */
  apiBase?: string;
  /** Logger. Default no-op. */
  log?: GatewayLogger;
  /**
   * Optional STT transcriber. When provided, voice and audio messages are
   * transcribed and forwarded as text. Fail-soft: if absent, or the transcriber
   * returns "" or throws, the message is silently skipped (never crashes the loop).
   */
  transcriber?: VoiceTranscriber;
  /**
   * When true, inbound photo messages are downloaded (largest size) and
   * forwarded as an image attachment with the caption as text. Default false:
   * photos fall through to the text-only guard (dropped) ; flag-gated because
   * the agent loop wire-through for image attachments is a separate slice.
   */
  acceptPhotos?: boolean;
}

/**
 * Optional callback that transcribes raw audio bytes to text.
 * Injected into the adapter so the gateway layer stays free of STT dependencies.
 * Must return "" (empty string) on failure; it must never throw into the loop.
 */
export type VoiceTranscriber = (
  audio: ArrayBuffer | Uint8Array,
  mimeType: string,
  filename: string,
) => Promise<string>;

/** One size of a Telegram photo (the `message.photo` array is smallest->largest). */
interface TgPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string };
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; mime_type?: string };
    photo?: TgPhotoSize[];
    /** Caption on a photo / media message. */
    caption?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
    message?: {
      message_id?: number;
      chat?: { id?: number | string };
    };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Render a poll failure with its root cause when one is attached. undici (the
 * fetch implementation Node ships) wraps the real network error — a socket
 * reset, a DNS failure, a timeout — inside `error.cause` and surfaces only the
 * generic "fetch failed" as `error.message`. Logging the message alone makes
 * every poll failure look identical regardless of what actually happened,
 * which is exactly what stops anyone from telling a transient socket reset
 * apart from a real outage. Exported for unit testing.
 */
export function describePollError(err: unknown): string {
  const error = err as { message?: unknown; cause?: unknown };
  const message = typeof error?.message === "string" ? error.message : String(err);
  const cause = error?.cause;
  if (cause === undefined || cause === null) return message;
  const causeStr =
    cause instanceof Error
      ? (cause as { code?: unknown }).code
        ? `${cause.message} (${(cause as { code?: unknown }).code})`
        : cause.message
      : String(cause);
  return `${message} ; cause: ${causeStr}`;
}

/**
 * Pick the largest size from a Telegram `message.photo` array (max by
 * file_size, falling back to pixel area, else the last entry since Telegram
 * orders smallest->largest). Returns null for an empty array. Pure + exported
 * for unit testing.
 */
export function pickLargestPhoto(photos: TgPhotoSize[]): TgPhotoSize | null {
  if (!photos || photos.length === 0) return null;
  const score = (p: TgPhotoSize): number => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);
  return photos.reduce((best, p) => (score(p) >= score(best) ? p : best));
}

/** Encode a button's `callback_data` ; `apv:<token>:<a|r>`, well under 64 B. */
function buildCallbackData(token: string, approved: boolean): string {
  return `${CALLBACK_PREFIX}:${token}:${approved ? "a" : "r"}`;
}

/**
 * Parse `apv:<token>:<a|r>` back into a token + verdict. Returns null for any
 * payload that is not one of our approval buttons (a foreign keyboard, a
 * malformed string), so callbacks we did not create are safely ignored.
 */
function parseCallbackData(data: string): { token: string; approved: boolean } | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, token, verdict] = parts;
  if (token === "" || (verdict !== "a" && verdict !== "r")) return null;
  return { token, approved: verdict === "a" };
}

/**
 * Create a Telegram gateway adapter.
 * @public
 */
export function createTelegramAdapter(opts: TelegramAdapterOptions): GatewayAdapter {
  const botToken = opts.botToken.trim();
  if (botToken === "") {
    throw new Error("telegram adapter: botToken is required");
  }
  const allowed = new Set(opts.allowedChatIds.map((c) => String(c).trim()));
  allowed.delete("");
  if (allowed.size === 0) {
    throw new Error(
      "telegram adapter: allowedChatIds must be non-empty (zero-trust — an " +
        "empty allowlist would let any stranger who finds the bot drive the agent)",
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
  const pollTimeoutSec = opts.pollTimeoutSec ?? 25;
  const log = opts.log ?? NOOP_LOGGER;
  const transcriber = opts.transcriber ?? null;
  const acceptPhotos = opts.acceptPhotos ?? false;

  /** getFile + download a Telegram file by id -> base64, or null on failure. */
  async function downloadFileB64(fileId: string): Promise<string | null> {
    const info = await tgCall<{ file_path?: string }>("getFile", {
      file_id: fileId,
    });
    const filePath = info.file_path;
    if (!filePath) return null;
    const res = await fetchImpl(`${apiBase}/file/bot${botToken}/${filePath}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }

  let running = false;
  let offset = 0;
  let loopDone: Promise<void> = Promise.resolve();
  let pollAbort: AbortController | null = null;
  let onApprovalCallback: ((cb: ApprovalCallback) => void) | null = null;

  /**
   * Maps the short on-the-wire token → the real HITL request id, plus the
   * sent message's coordinates so a tap can edit it in place. Bounded by the
   * number of in-flight approvals (one entry per `deliverApproval`, dropped on
   * the first tap), so no unbounded growth.
   */
  const tokenMap = new Map<
    string,
    { approvalId: string; chatId: string; messageId: number; text: string }
  >();
  let tokenSeq = 0;
  /** A short, collision-free token for a `callback_data` slot. */
  const nextToken = (): string => `t${(tokenSeq++).toString(36)}`;

  async function tgCall<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(`${apiBase}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!json || json.ok !== true) {
      throw new Error(`telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`);
    }
    return json.result as T;
  }

  /**
   * Send a single text chunk to one chat, with HTML parse_mode. On a Telegram
   * entity-parsing error (API 400 "can't parse entities") retry immediately as
   * plain text so the message is never silently dropped.
   */
  async function sendOne(
    chatId: string,
    htmlText: string,
    plainFallback: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ message_id?: number }> {
    try {
      return await tgCall<{ message_id?: number }>("sendMessage", {
        chat_id: chatId,
        text: htmlText,
        parse_mode: "HTML",
        ...extra,
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Telegram returns "can't parse entities" on invalid HTML markup.
      if (msg.includes("can't parse entities") || msg.includes("parse entities")) {
        log(`telegram: HTML parse failed for chat ${chatId} — retrying as plain text`);
        return tgCall<{ message_id?: number }>("sendMessage", {
          chat_id: chatId,
          text: plainFallback,
          ...extra,
        });
      }
      throw err;
    }
  }

  /**
   * Handle a tapped inline button. Zero-trust: a tap from a non-allowlisted
   * chat is ignored exactly like a non-allowlisted message. Telegram REQUIRES
   * `answerCallbackQuery` for every callback (the client spinner hangs
   * otherwise); we always answer, then edit the original message to record the
   * verdict, then route through the same approval path as `/approve`.
   */
  async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    const chatId = String(cq.message?.chat?.id ?? "");
    if (!allowed.has(chatId)) {
      log(`telegram: ignored callback from non-allowlisted chat ${chatId}`);
      // Still answer so a stranger's client does not hang on a spinner.
      await tgCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return;
    }
    const parsed = parseCallbackData(cq.data ?? "");
    if (!parsed) {
      await tgCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
      return;
    }
    const slot = tokenMap.get(parsed.token);
    // Drop the token first ; a verdict is one-shot, a double-tap is a no-op.
    tokenMap.delete(parsed.token);
    const verdictWord = parsed.approved ? "✅ approved" : "❌ rejected";
    // Telegram requires this; it dismisses the client-side loading spinner.
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: slot ? verdictWord : "already settled",
    }).catch((err) => log(`telegram: answerCallbackQuery failed ; ${(err as Error).message}`));
    if (!slot) {
      // Token already consumed (double-tap or restart) ; nothing to resolve.
      return;
    }
    // Replace the keyboard with a static line recording the chosen verdict.
    // Use HTML parse_mode consistent with the initial send; fall back to plain
    // text if entity parsing fails (same robustness contract as sendOne).
    const editRaw = `${slot.text}\n\n${verdictWord}`;
    const editHtml = markdownToTelegramHtml(editRaw);
    await tgCall("editMessageText", {
      chat_id: slot.chatId,
      message_id: slot.messageId,
      text: editHtml,
      parse_mode: "HTML",
    }).catch(async (err) => {
      const msg = (err as Error).message ?? "";
      if (msg.includes("can't parse entities") || msg.includes("parse entities")) {
        await tgCall("editMessageText", {
          chat_id: slot.chatId,
          message_id: slot.messageId,
          text: markdownToPlainText(editRaw),
        }).catch((e) => log(`telegram: editMessageText failed ; ${(e as Error).message}`));
      } else {
        log(`telegram: editMessageText failed ; ${msg}`);
      }
    });
    onApprovalCallback?.({
      platform: "telegram",
      chatId,
      userId: String(cq.from?.id ?? ""),
      approvalId: slot.approvalId,
      approved: parsed.approved,
      ts: new Date().toISOString(),
    });
  }

  async function pollOnce(onMessage: (m: InboundMessage) => void): Promise<void> {
    pollAbort = new AbortController();
    // Watchdog: a stuck poll is aborted slightly after the server-side limit.
    const watchdog = setTimeout(() => pollAbort?.abort(), (pollTimeoutSec + 15) * 1000);
    watchdog.unref?.();
    try {
      const updates = await tgCall<TgUpdate[]>(
        "getUpdates",
        {
          offset,
          timeout: pollTimeoutSec,
          allowed_updates: ["message", "callback_query"],
        },
        pollAbort.signal,
      );
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        if (u.callback_query) {
          await handleCallback(u.callback_query);
          continue;
        }
        const m = u.message;
        if (!m) continue;
        const chatId = String(m.chat?.id ?? "");
        if (!allowed.has(chatId)) {
          log(`telegram: ignored message from non-allowlisted chat ${chatId}`);
          continue;
        }

        // Voice / audio note handling (STT path), before the text-only guard.
        const voiceOrAudio = m.voice ?? m.audio ?? null;
        if (voiceOrAudio !== null) {
          if (transcriber === null) {
            log("telegram: voice message received but no transcriber configured; skipping");
            continue;
          }
          try {
            // Step 1: resolve the file path via getFile.
            const fileInfo = await tgCall<{ file_path?: string }>("getFile", {
              file_id: voiceOrAudio.file_id,
            });
            const filePath = fileInfo.file_path;
            if (!filePath) {
              log("telegram: getFile returned no file_path; skipping voice message");
              continue;
            }
            // Step 2: download the raw audio bytes.
            const downloadUrl = `${apiBase}/file/bot${botToken}/${filePath}`;
            const audioRes = await fetchImpl(downloadUrl);
            if (!audioRes.ok) {
              log(`telegram: voice download failed HTTP ${audioRes.status}; skipping`);
              continue;
            }
            const audioBytes = await audioRes.arrayBuffer();
            // Telegram voice notes are Opus in an OGG container (.oga).
            const mimeType = voiceOrAudio.mime_type ?? "audio/ogg";
            const filename = filePath.split("/").pop() ?? "voice.oga";
            // Step 3: transcribe (fail-soft).
            let transcript = "";
            try {
              transcript = await transcriber(audioBytes, mimeType, filename);
            } catch (tErr) {
              log(`telegram: transcription error: ${(tErr as Error).message}`);
            }
            if (!transcript || transcript.trim() === "") {
              log("telegram: transcription returned empty; skipping voice message");
              continue;
            }
            onMessage({
              platform: "telegram",
              chatId,
              userId: String(m.from?.id ?? ""),
              text: transcript.trim(),
              ts: new Date().toISOString(),
            });
          } catch (vErr) {
            log(`telegram: voice handling error: ${(vErr as Error).message}`);
          }
          continue;
        }

        // Photo handling (vision path) ; behind the acceptPhotos flag, before
        // the text-only guard. Download the largest size + forward it as an
        // image attachment with the caption as text. Fail-soft.
        if (acceptPhotos && Array.isArray(m.photo) && m.photo.length > 0) {
          try {
            const largest = pickLargestPhoto(m.photo);
            const dataBase64 = largest ? await downloadFileB64(largest.file_id) : null;
            if (dataBase64) {
              onMessage({
                platform: "telegram",
                chatId,
                userId: String(m.from?.id ?? ""),
                text: m.caption ?? "",
                attachments: [{ kind: "image", mediaType: "image/jpeg", dataBase64 }],
                ts: new Date().toISOString(),
              });
            } else {
              log("telegram: photo download failed; skipping");
            }
          } catch (pErr) {
            log(`telegram: photo handling error: ${(pErr as Error).message}`);
          }
          continue;
        }

        // Text message (existing path).
        if (typeof m.text !== "string") continue;
        onMessage({
          platform: "telegram",
          chatId,
          userId: String(m.from?.id ?? ""),
          text: m.text,
          ts: new Date().toISOString(),
        });
      }
    } finally {
      clearTimeout(watchdog);
    }
  }

  return {
    platform: "telegram",

    async start(onMessage, onCallback): Promise<void> {
      onApprovalCallback = onCallback ?? null;
      if (running) return;
      running = true;
      loopDone = (async () => {
        while (running) {
          try {
            await pollOnce(onMessage);
          } catch (err) {
            if (running) {
              log(`telegram: poll error — ${describePollError(err)}`);
              await sleep(2000);
            }
          }
        }
      })();
    },

    async deliver(text): Promise<void> {
      const html = markdownToTelegramHtml(text);
      const plain = markdownToPlainText(text);
      // Split on paragraph/line boundaries so each chunk fits the 4096-char limit.
      const chunks = splitIntoChunks(html, TELEGRAM_MAX_CHARS);
      const plainChunks = splitIntoChunks(plain, TELEGRAM_MAX_CHARS);
      for (const chatId of allowed) {
        for (let i = 0; i < chunks.length; i++) {
          try {
            await sendOne(chatId, chunks[i] ?? "", plainChunks[i] ?? plain);
          } catch (err) {
            log(`telegram: deliver to ${chatId} failed — ${(err as Error).message}`);
          }
        }
      }
    },

    async deliverApproval(prompt: ApprovalPrompt): Promise<void> {
      // Approval prompts are short by construction; no chunking needed.
      // Truncate at limit as a safety net.
      const rawText = prompt.text;
      const htmlText = markdownToTelegramHtml(rawText);
      const htmlBody =
        htmlText.length > TELEGRAM_MAX_CHARS
          ? `${htmlText.slice(0, TELEGRAM_MAX_CHARS - 1)}…`
          : htmlText;
      const plainBody = (() => {
        const p = markdownToPlainText(rawText);
        return p.length > TELEGRAM_MAX_CHARS ? `${p.slice(0, TELEGRAM_MAX_CHARS - 1)}…` : p;
      })();
      for (const chatId of allowed) {
        // One token per (chat, request): a tap on this chat's message edits
        // this chat's message, and resolves the one shared approval id.
        const token = nextToken();
        const reply_markup = {
          inline_keyboard: [
            [
              {
                text: "✅ Approve",
                callback_data: buildCallbackData(token, true),
              },
              {
                text: "❌ Reject",
                callback_data: buildCallbackData(token, false),
              },
            ],
          ],
        };
        try {
          const sent = await sendOne(chatId, htmlBody, plainBody, {
            reply_markup,
          });
          tokenMap.set(token, {
            approvalId: prompt.id,
            chatId,
            messageId: sent?.message_id ?? 0,
            // Store the raw text so editMessageText can re-convert on verdict.
            text: rawText,
          });
        } catch (err) {
          log(`telegram: deliverApproval to ${chatId} failed ; ${(err as Error).message}`);
        }
      }
    },

    async stop(): Promise<void> {
      running = false;
      pollAbort?.abort();
      try {
        await loopDone;
      } catch {
        /* loop already exiting */
      }
    },
  };
}
