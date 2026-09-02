/**
 * Tests for the multi-platform gateway (T4).
 *
 * The gateway multiplexes ONE agent session across several messaging
 * surfaces. These tests prove: event rendering, inbound command routing
 * (/approve, /reject, /whisper, /status), outbound broadcast, and the three
 * platform adapters (Telegram long-polling, Discord Gateway WS, Slack Socket
 * Mode) — each with an injected fetch / WebSocket so no network is touched.
 */

import { describe, expect, it } from "vitest";
import {
  describePollError,
  markdownToTelegramHtml,
} from "../src/remote/gateway/adapters/telegram.js";
import {
  type ApprovalCallback,
  type ApprovalPrompt,
  type GatewayAdapter,
  type InboundMessage,
  type WebSocketLike,
  __resetEventSeq,
  createDiscordAdapter,
  createGateway,
  createRemoteApprovalChannel,
  createRemoteControlHub,
  createSlackAdapter,
  createTelegramAdapter,
  makeEvent,
  renderEventForChat,
} from "../src/remote/index.js";

// ─── Test doubles ────────────────────────────────────────────────────────────

/** A GatewayAdapter that records what it delivers and lets a test push msgs. */
class FakeAdapter implements GatewayAdapter {
  readonly platform: string;
  delivered: string[] = [];
  started = false;
  stopped = false;
  protected inbound: ((m: InboundMessage) => void) | null = null;
  protected approvalCb: ((cb: ApprovalCallback) => void) | null = null;

  constructor(platform = "fake") {
    this.platform = platform;
  }

  async start(
    onMessage: (m: InboundMessage) => void,
    onApprovalCallback?: (cb: ApprovalCallback) => void,
  ): Promise<void> {
    this.started = true;
    this.inbound = onMessage;
    this.approvalCb = onApprovalCallback ?? null;
  }

  async deliver(text: string): Promise<void> {
    this.delivered.push(text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Test driver — simulate an inbound platform message. */
  receive(text: string, chatId = "c1", userId = "u1"): void {
    this.inbound?.({
      platform: this.platform,
      chatId,
      userId,
      text,
      ts: new Date().toISOString(),
    });
  }
}

/**
 * A FakeAdapter that ALSO renders tappable verdicts (`deliverApproval`). It
 * records each prompt and can simulate a button tap that routes through the
 * gateway's onApprovalCallback path ; proving the button half end to end.
 */
class ButtonAdapter extends FakeAdapter {
  approvals: ApprovalPrompt[] = [];

  async deliverApproval(prompt: ApprovalPrompt): Promise<void> {
    this.approvals.push(prompt);
  }

  /** Test driver ; simulate tapping Approve/Reject on the last prompt. */
  tap(approved: boolean, chatId = "c1", userId = "u1"): void {
    const last = this.approvals[this.approvals.length - 1];
    if (!last) throw new Error("ButtonAdapter.tap: no approval prompt to tap");
    this.approvalCb?.({
      platform: this.platform,
      chatId,
      userId,
      approvalId: last.id,
      approved,
      ts: new Date().toISOString(),
    });
  }
}

/** A WebSocketLike fake — records sent frames, lets a test drive events. */
class FakeWS implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Parsed view of every frame sent. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const tick = (): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, 15);
  });

const sleepMs = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// ─── renderEventForChat ──────────────────────────────────────────────────────

describe("renderEventForChat", () => {
  it("renders an assistant message verbatim", () => {
    expect(renderEventForChat(makeEvent("assistant.message", { content: "done" }))).toBe("done");
  });

  it("skips noisy events (run.step, assistant.delta)", () => {
    expect(
      renderEventForChat(
        makeEvent("run.step", {
          stepIndex: 0,
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        }),
      ),
    ).toBeNull();
    expect(renderEventForChat(makeEvent("assistant.delta", { text: "x" }))).toBeNull();
  });

  it("renders a HITL request with an approve/reject hint", () => {
    const out = renderEventForChat(
      makeEvent("hitl.request", {
        requestId: "r",
        action: "deploy",
        context: "prod",
      }),
    );
    expect(out).toContain("approval needed");
    expect(out).toContain("/approve");
  });

  it("renders tool events only in verbose mode", () => {
    const ev = makeEvent("tool.call.end", {
      callId: "c",
      toolName: "run_bash",
      ok: true,
      resultPreview: "ok",
    });
    expect(renderEventForChat(ev)).toBeNull();
    expect(renderEventForChat(ev, { verbose: true })).toContain("run_bash");
  });

  it("truncates long output to maxChars", () => {
    const long = "x".repeat(5000);
    const out = renderEventForChat(makeEvent("assistant.message", { content: long }), {
      maxChars: 100,
    });
    expect(out).not.toBeNull();
    expect(out?.length).toBe(100);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("does not echo a whispered instruction", () => {
    expect(
      renderEventForChat(
        makeEvent("instruction.injected", {
          text: "secret hint",
          source: "telegram:1",
          whisper: true,
        }),
      ),
    ).toBeNull();
  });

  it("renders run.finished with cost + step count", () => {
    const out = renderEventForChat(
      makeEvent("run.finished", {
        runId: "r",
        stopReason: "completed",
        stepCount: 7,
        costUsd: 0.0123,
        finishedAt: new Date().toISOString(),
      }),
    );
    expect(out).toContain("7 steps");
    expect(out).toContain("0.0123");
  });
});

// ─── Gateway routing ─────────────────────────────────────────────────────────

describe("gateway — routing", () => {
  it("plain inbound message → enqueued as a steering instruction", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();
    expect(adapter.started).toBe(true);

    adapter.receive("focus on the tests", "chatX");
    const drained = hub.inbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.text).toBe("focus on the tests");
    expect(drained[0]?.source).toBe("fake:chatX");
    expect(drained[0]?.whisper).toBe(false);
    await gw.stop();
  });

  it("/whisper → enqueued as a whisper instruction", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();

    adapter.receive("/whisper the deploy key rotated");
    const drained = hub.inbox.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.text).toBe("the deploy key rotated");
    expect(drained[0]?.whisper).toBe(true);
    await gw.stop();
  });

  it("/stop → calls onStop out-of-band and does NOT enqueue", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    let stopCalls = 0;
    const gw = createGateway({
      hub,
      adapters: [adapter],
      greeting: false,
      onStop: () => {
        stopCalls += 1;
        return true;
      },
    });
    await gw.start();
    adapter.receive("/stop");
    expect(stopCalls).toBe(1);
    expect(hub.inbox.drain()).toHaveLength(0); // never routed through the inbox
    await gw.stop();
  });

  it("/cancel is an alias for /stop", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    let stopCalls = 0;
    const gw = createGateway({
      hub,
      adapters: [adapter],
      greeting: false,
      onStop: () => {
        stopCalls += 1;
        return true;
      },
    });
    await gw.start();
    adapter.receive("/cancel");
    expect(stopCalls).toBe(1);
    await gw.stop();
  });

  it("/stop without an onStop hook is harmless (not enqueued)", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();
    adapter.receive("/stop");
    expect(hub.inbox.drain()).toHaveLength(0);
    await gw.stop();
  });

  it("/revive <id> → calls onRevive out-of-band and does NOT enqueue (uplift-C)", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const revived: string[] = [];
    const gw = createGateway({
      hub,
      adapters: [adapter],
      greeting: false,
      onRevive: (id) => {
        revived.push(id);
        return true;
      },
    });
    await gw.start();
    adapter.receive("/revive req-123");
    expect(revived).toEqual(["req-123"]);
    expect(hub.inbox.drain()).toHaveLength(0); // out-of-band, never steering
    await gw.stop();
  });

  it("/revive without an id asks for usage and does NOT call onRevive", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    let calls = 0;
    const gw = createGateway({
      hub,
      adapters: [adapter],
      greeting: false,
      onRevive: () => {
        calls += 1;
        return true;
      },
    });
    await gw.start();
    adapter.receive("/revive");
    expect(calls).toBe(0);
    expect(hub.inbox.drain()).toHaveLength(0);
    await gw.stop();
  });

  it("/revive without an onRevive hook is harmless (not enqueued)", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();
    adapter.receive("/revive req-1");
    expect(hub.inbox.drain()).toHaveLength(0);
    await gw.stop();
  });

  it("outbound assistant.message is broadcast to every adapter", async () => {
    const hub = createRemoteControlHub();
    const a1 = new FakeAdapter("p1");
    const a2 = new FakeAdapter("p2");
    const gw = createGateway({ hub, adapters: [a1, a2], greeting: false });
    await gw.start();

    hub.emit(makeEvent("assistant.message", { content: "hello from the agent" }));
    await tick();
    expect(a1.delivered).toContain("hello from the agent");
    expect(a2.delivered).toContain("hello from the agent");
    await gw.stop();
  });

  it("/approve resolves the latest pending HITL via the approval channel", async () => {
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const adapter = new FakeAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    const id = await approvalChannel.send({
      agentId: "test-agent",
      action: "deploy",
      context: "prod",
      timeoutMs: 60_000,
    });
    adapter.receive("/approve");
    const verdict = await approvalChannel.poll(id);
    expect(verdict?.approved).toBe(true);
    expect(verdict?.by).toBe("fake:c1");
    await gw.stop();
    approvalChannel.dispose();
  });

  it("/reject rejects the latest pending HITL", async () => {
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const adapter = new FakeAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    const id = await approvalChannel.send({
      agentId: "test-agent",
      action: "rm -rf",
      context: "danger",
      timeoutMs: 60_000,
    });
    adapter.receive("/reject");
    const verdict = await approvalChannel.poll(id);
    expect(verdict?.approved).toBe(false);
    await gw.stop();
    approvalChannel.dispose();
  });

  it("a HITL request is delivered via deliverApproval when the adapter supports buttons", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const adapter = new ButtonAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    const id = await approvalChannel.send({
      agentId: "test-agent",
      action: "run_bash",
      context: "rm -rf /tmp/x",
      timeoutMs: 60_000,
    });
    await tick();
    // The button-capable adapter got the structured prompt, NOT a text deliver.
    expect(adapter.approvals).toHaveLength(1);
    expect(adapter.approvals[0]?.id).toBe(id);
    expect(adapter.approvals[0]?.action).toBe("run_bash");
    expect(adapter.approvals[0]?.text).toContain("approval needed");
    expect(adapter.delivered).toHaveLength(0);
    await gw.stop();
    approvalChannel.dispose();
  });

  it("a button tap resolves the approval through the same channel as text", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const adapter = new ButtonAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    const id = await approvalChannel.send({
      agentId: "test-agent",
      action: "deploy",
      context: "prod",
      timeoutMs: 60_000,
    });
    await tick();
    adapter.tap(true, "chatZ", "userZ");
    const verdict = await approvalChannel.poll(id);
    expect(verdict?.approved).toBe(true);
    expect(verdict?.by).toBe("fake:chatZ");
    await gw.stop();
    approvalChannel.dispose();
  });

  it("a reject tap rejects the approval", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const adapter = new ButtonAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    const id = await approvalChannel.send({
      agentId: "test-agent",
      action: "rm -rf",
      context: "danger",
      timeoutMs: 60_000,
    });
    await tick();
    adapter.tap(false);
    const verdict = await approvalChannel.poll(id);
    expect(verdict?.approved).toBe(false);
    await gw.stop();
    approvalChannel.dispose();
  });

  it("a text-only adapter falls back to deliver for a HITL request", async () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const approvalChannel = createRemoteApprovalChannel({ sink: hub });
    const textAdapter = new FakeAdapter("text");
    const buttonAdapter = new ButtonAdapter("buttons");
    const gw = createGateway({
      hub,
      adapters: [textAdapter, buttonAdapter],
      approvalChannel,
      greeting: false,
    });
    await gw.start();

    await approvalChannel.send({
      agentId: "test-agent",
      action: "deploy",
      context: "prod",
      timeoutMs: 60_000,
    });
    await tick();
    // Text adapter got the rendered line; button adapter got the structured prompt.
    expect(textAdapter.delivered.some((d) => d.includes("approval needed"))).toBe(true);
    expect(buttonAdapter.approvals).toHaveLength(1);
    await gw.stop();
    approvalChannel.dispose();
  });

  it("/status replies with a state summary", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();

    adapter.receive("/status");
    await tick();
    expect(adapter.delivered.some((d) => d.startsWith("📊"))).toBe(true);
    await gw.stop();
  });

  it("an approval command is ignored when no HITL channel is wired", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();
    // Must not throw, and must not be treated as a steering instruction.
    adapter.receive("/approve");
    expect(hub.inbox.drain()).toHaveLength(0);
    await gw.stop();
  });

  it("greeting is broadcast on start, suppressed by greeting:false", async () => {
    const a1 = new FakeAdapter("g1");
    const gw1 = createGateway({
      hub: createRemoteControlHub(),
      adapters: [a1],
    });
    await gw1.start();
    expect(a1.delivered.some((d) => d.includes("gateway online"))).toBe(true);
    await gw1.stop();

    const a2 = new FakeAdapter("g2");
    const gw2 = createGateway({
      hub: createRemoteControlHub(),
      adapters: [a2],
      greeting: false,
    });
    await gw2.start();
    expect(a2.delivered).toHaveLength(0);
    await gw2.stop();
  });

  it("stop detaches from the hub — later events are not delivered", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({ hub, adapters: [adapter], greeting: false });
    await gw.start();
    await gw.stop();
    expect(adapter.stopped).toBe(true);

    hub.emit(makeEvent("assistant.message", { content: "after stop" }));
    await tick();
    expect(adapter.delivered).not.toContain("after stop");
  });

  it("exposes the multiplexed platforms", () => {
    const gw = createGateway({
      hub: createRemoteControlHub(),
      adapters: [new FakeAdapter("telegram"), new FakeAdapter("discord")],
      greeting: false,
    });
    expect(gw.platforms).toEqual(["telegram", "discord"]);
  });
});

// ─── Telegram adapter ────────────────────────────────────────────────────────

describe("telegram adapter", () => {
  interface TgUpdate {
    update_id: number;
    message?: {
      text?: string;
      chat?: { id?: number | string };
      from?: { id?: number | string };
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

  /** Every Telegram API call the adapter made, keyed by method, with its body. */
  interface TgCallRecord {
    method: string;
    body: Record<string, unknown>;
  }

  /**
   * Fake fetch: scripted getUpdates batches + a long-poll-like drain. Records
   * every non-getUpdates call into `calls` (and, for sendMessage, into the
   * legacy `sent` array). `sendMessage` returns an incrementing `message_id`
   * so the adapter can later target it via editMessageText.
   */
  function telegramFetch(
    updates: TgUpdate[][],
    sent: unknown[],
    calls: TgCallRecord[] = [],
  ): typeof fetch {
    let call = 0;
    let messageId = 100;
    return (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.slice(u.lastIndexOf("/") + 1);
      if (method === "getUpdates") {
        const batch = updates[call++] ?? [];
        if (batch.length > 0) {
          return jsonResponse({ ok: true, result: batch });
        }
        // Simulate a long-poll: pending until the request is aborted.
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          sig?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "sendMessage") {
        sent.push(body);
        return jsonResponse({ ok: true, result: { message_id: messageId++ } });
      }
      if (method === "answerCallbackQuery" || method === "editMessageText") {
        return jsonResponse({ ok: true, result: {} });
      }
      return jsonResponse({ ok: false, description: "unknown method" });
    }) as unknown as typeof fetch;
  }

  it("receives an allowlisted message, ignores a stranger's", async () => {
    const sent: unknown[] = [];
    const received: InboundMessage[] = [];
    const adapter = createTelegramAdapter({
      botToken: "TOKEN",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl: telegramFetch(
        [
          [
            {
              update_id: 1,
              message: { text: "hello", chat: { id: 111 }, from: { id: 9 } },
            },
            {
              update_id: 2,
              message: { text: "intruder", chat: { id: 999 }, from: { id: 7 } },
            },
          ],
        ],
        sent,
      ),
    });
    await adapter.start((m) => received.push(m));
    await tick();
    await adapter.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("hello");
    expect(received[0]?.chatId).toBe("111");
    expect(received[0]?.platform).toBe("telegram");
  });

  it("deliver sends to every allowlisted chat", async () => {
    const sent: Array<{ chat_id: string; text: string }> = [];
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111", "222"],
      fetchImpl: telegramFetch([], sent),
    });
    await adapter.deliver("ping");
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.chat_id).sort()).toEqual(["111", "222"]);
    expect(sent[0]?.text).toBe("ping");
  });

  it("rejects an empty allowlist (zero-trust)", () => {
    expect(() => createTelegramAdapter({ botToken: "T", allowedChatIds: [] })).toThrow(/non-empty/);
  });

  it("rejects a missing bot token", () => {
    expect(() => createTelegramAdapter({ botToken: "   ", allowedChatIds: ["1"] })).toThrow(
      /botToken/,
    );
  });

  it("deliver logs a failed sendMessage", async () => {
    const logs: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/sendMessage")) {
        return jsonResponse({ ok: false, description: "chat not found" });
      }
      return jsonResponse({ ok: true, result: [] });
    }) as unknown as typeof fetch;
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl,
      log: (m) => logs.push(m),
    });
    await adapter.deliver("hello");
    expect(logs.some((l) => l.includes("chat not found"))).toBe(true);
  });

  it("describePollError surfaces error.cause alongside the generic message", () => {
    // undici's fetch throws "TypeError: fetch failed" for every network-level
    // failure and buries the real reason (a socket reset, a DNS failure, a
    // timeout) inside `.cause`. Without this, every poll failure is logged
    // identically no matter what actually happened.
    const withCode = new Error("fetch failed");
    (withCode as unknown as { cause: unknown }).cause = Object.assign(
      new Error("other side closed"),
      { code: "ECONNRESET" },
    );
    expect(describePollError(withCode)).toBe(
      "fetch failed ; cause: other side closed (ECONNRESET)",
    );

    const withoutCode = new Error("fetch failed");
    (withoutCode as unknown as { cause: unknown }).cause = new Error("plain cause");
    expect(describePollError(withoutCode)).toBe("fetch failed ; cause: plain cause");

    const noCause = new Error("aborted");
    expect(describePollError(noCause)).toBe("aborted");
  });

  it("poll error log includes error.cause, not just the generic message", async () => {
    const logs: string[] = [];
    const causeErr = Object.assign(new Error("other side closed"), { code: "ECONNRESET" });
    const fetchImpl = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: causeErr });
    }) as unknown as typeof fetch;
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl,
      log: (m) => logs.push(m),
    });
    await adapter.start(() => {});
    await tick();
    await adapter.stop();
    expect(logs.some((l) => l.includes("fetch failed") && l.includes("ECONNRESET"))).toBe(true);
  });

  it("ignores an update that carries no message text", async () => {
    const received: InboundMessage[] = [];
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl: telegramFetch([[{ update_id: 1, message: { chat: { id: 111 } } }]], []),
    });
    await adapter.start((m) => received.push(m));
    await tick();
    await adapter.stop();
    expect(received).toHaveLength(0);
  });

  it("deliver splits a message over the 4096-char limit into multiple sends", async () => {
    const sent: Array<{ text: string }> = [];
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl: telegramFetch([], sent),
    });
    // 5000 identical chars with no newlines — will be hard-cut into 2 chunks.
    await adapter.deliver("z".repeat(5000));
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const chunk of sent) {
      expect(chunk.text.length).toBeLessThanOrEqual(4096);
    }
    // The full content is preserved across all chunks.
    const total = sent.map((s) => s.text).join("");
    expect(total).toBe("z".repeat(5000));
  });

  it("getUpdates subscribes to callback_query updates", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const spyFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/getUpdates")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return jsonResponse({ ok: true, result: {} });
    }) as unknown as typeof fetch;
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl: spyFetch,
    });
    await adapter.start(() => {});
    await tick();
    await adapter.stop();
    expect(bodies[0]?.allowed_updates).toEqual(["message", "callback_query"]);
  });

  it("deliverApproval sends an inline keyboard with apv callback_data", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl: telegramFetch([], sent),
    });
    expect(adapter.deliverApproval).toBeTypeOf("function");
    await adapter.deliverApproval?.({
      id: "req-abc",
      action: "run_bash",
      context: "rm -rf",
      text: "⚠️ approval needed: run_bash",
    });
    expect(sent).toHaveLength(1);
    const markup = sent[0]?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const row = markup.inline_keyboard[0];
    expect(row?.[0]?.text).toBe("✅ Approve");
    expect(row?.[1]?.text).toBe("❌ Reject");
    // callback_data is the compact `apv:<token>:<verdict>` form, never the raw id.
    expect(row?.[0]?.callback_data).toMatch(/^apv:t[0-9a-z]+:a$/);
    expect(row?.[1]?.callback_data).toMatch(/^apv:t[0-9a-z]+:r$/);
    expect(row?.[0]?.callback_data).not.toContain("req-abc");
    for (const btn of row ?? []) {
      expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("a button tap answers the query, edits the message, and resolves via onApprovalCallback", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const calls: TgCallRecord[] = [];
    const callbacks: ApprovalCallback[] = [];
    // A phased fetch on a SINGLE adapter instance: after the prompt's
    // sendMessage, the next getUpdates poll returns a callback_query carrying
    // the EXACT callback_data the adapter minted (read back from the recorded
    // sendMessage body). This exercises the real deliver → poll → tap path,
    // and the token must resolve against the adapter's own in-memory map.
    let promptOnWire = false;
    let callbackDelivered = false;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.slice(u.lastIndexOf("/") + 1);
      if (method === "getUpdates") {
        // Once the prompt is on the wire, the next poll returns the tap.
        if (promptOnWire) {
          promptOnWire = false;
          callbackDelivered = true;
          const data =
            (
              sent[0]?.reply_markup as {
                inline_keyboard: Array<Array<{ callback_data: string }>>;
              }
            )?.inline_keyboard[0]?.[0]?.callback_data ?? "";
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: "cbq-1",
                  data,
                  from: { id: 9 },
                  message: { message_id: 100, chat: { id: 111 } },
                },
              },
            ],
          });
        }
        // After the tap is consumed, long-poll (pending until stop aborts).
        if (callbackDelivered) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        // Before the prompt exists, resolve an empty batch after a short delay
        // so the loop yields control to `deliverApproval` (no busy-spin).
        await sleepMs(5);
        return jsonResponse({ ok: true, result: [] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "sendMessage") {
        sent.push(body);
        promptOnWire = true; // let the next poll deliver the tap
        return jsonResponse({ ok: true, result: { message_id: 100 } });
      }
      return jsonResponse({ ok: true, result: {} });
    }) as unknown as typeof fetch;

    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl,
    });
    // start() must capture onApprovalCallback before the tap arrives.
    await adapter.start(
      () => {},
      (cb) => callbacks.push(cb),
    );
    await adapter.deliverApproval?.({
      id: "req-xyz",
      action: "deploy",
      context: "prod",
      text: "⚠️ approval needed: deploy",
    });
    await tick();
    await tick();
    await adapter.stop();

    const approveData =
      (
        sent[0]?.reply_markup as {
          inline_keyboard: Array<Array<{ callback_data: string }>>;
        }
      )?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect(approveData).toMatch(/^apv:/);
    // Telegram requires answerCallbackQuery for every callback.
    const answer = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer?.body.callback_query_id).toBe("cbq-1");
    // The original message is edited to record the verdict.
    const edit = calls.find((c) => c.method === "editMessageText");
    expect(edit?.body.message_id).toBe(100);
    expect(String(edit?.body.text)).toContain("✅ approved");
    // The verdict is routed to onApprovalCallback with the real approval id.
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.approvalId).toBe("req-xyz");
    expect(callbacks[0]?.approved).toBe(true);
    expect(callbacks[0]?.platform).toBe("telegram");
    expect(callbacks[0]?.chatId).toBe("111");
  });

  it("ignores a callback from a non-allowlisted chat but still answers it (zero-trust)", async () => {
    const calls: TgCallRecord[] = [];
    const callbacks: ApprovalCallback[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.slice(u.lastIndexOf("/") + 1);
      if (method === "getUpdates") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          offset?: number;
        };
        if ((body.offset ?? 0) === 0) {
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: "cbq-stranger",
                  data: "apv:t0:a",
                  from: { id: 7 },
                  message: { message_id: 5, chat: { id: 999 } },
                },
              },
            ],
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      calls.push({
        method,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true, result: {} });
    }) as unknown as typeof fetch;
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      pollTimeoutSec: 1,
      fetchImpl,
      log: (m) => logs.push(m),
    });
    await adapter.start(
      () => {},
      (cb) => callbacks.push(cb),
    );
    await tick();
    await adapter.stop();

    // No verdict routed, no message edited ; the stranger is ignored.
    expect(callbacks).toHaveLength(0);
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false);
    expect(logs.some((l) => l.includes("non-allowlisted chat 999"))).toBe(true);
    // ...but the spinner is still dismissed so the stranger's client is not stuck.
    const answer = calls.find((c) => c.method === "answerCallbackQuery");
    expect(answer?.body.callback_query_id).toBe("cbq-stranger");
  });
});

// ─── markdownToTelegramHtml converter ────────────────────────────────────────

describe("markdownToTelegramHtml", () => {
  it("escapes & < > before applying any formatting", () => {
    expect(markdownToTelegramHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("converts **bold** and __bold__ to <b>", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
    expect(markdownToTelegramHtml("__world__")).toBe("<b>world</b>");
  });

  it("converts *italic* and _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("*hi*")).toBe("<i>hi</i>");
    expect(markdownToTelegramHtml("_hi_")).toBe("<i>hi</i>");
  });

  it("converts ~~strike~~ to <s>", () => {
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  it("converts inline `code` to <code>", () => {
    expect(markdownToTelegramHtml("`foo()`")).toBe("<code>foo()</code>");
  });

  it("converts fenced code block without lang to <pre>", () => {
    const result = markdownToTelegramHtml("```\nhello\n```");
    expect(result).toBe("<pre>hello</pre>");
  });

  it("converts fenced code block with lang to <pre><code class=...>", () => {
    const result = markdownToTelegramHtml("```typescript\nconst x = 1;\n```");
    expect(result).toContain('<pre><code class="language-typescript">');
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  it("escapes HTML inside fenced code blocks", () => {
    const result = markdownToTelegramHtml("```\na < b && c > d\n```");
    expect(result).toBe("<pre>a &lt; b &amp;&amp; c &gt; d</pre>");
  });

  it("does not apply bold/italic inside code spans", () => {
    // The asterisks inside a code span must remain literal.
    const result = markdownToTelegramHtml("`**not bold**`");
    expect(result).toBe("<code>**not bold**</code>");
    expect(result).not.toContain("<b>");
  });

  it("converts ### headers to <b> lines", () => {
    expect(markdownToTelegramHtml("## My Header")).toBe("<b>My Header</b>");
    expect(markdownToTelegramHtml("# Top")).toBe("<b>Top</b>");
    expect(markdownToTelegramHtml("### Sub")).toBe("<b>Sub</b>");
  });

  it("converts - and * bullet lines to Unicode bullet", () => {
    expect(markdownToTelegramHtml("- item one")).toBe("• item one");
    expect(markdownToTelegramHtml("* item two")).toBe("• item two");
  });

  it("converts [text](url) links to <a href=...>", () => {
    expect(markdownToTelegramHtml("[Vauban](https://vauban.tech)")).toBe(
      '<a href="https://vauban.tech">Vauban</a>',
    );
  });

  it("does not linkify non-http/https URLs (XSS guard)", () => {
    const result = markdownToTelegramHtml("[bad](javascript:alert(1))");
    expect(result).not.toContain("<a");
  });

  it("handles a realistic multi-element message", () => {
    const md = "## Result\n\n**Status**: done\n\n- item A\n- item B\n\n`code`";
    const result = markdownToTelegramHtml(md);
    expect(result).toContain("<b>Result</b>");
    expect(result).toContain("<b>Status</b>");
    expect(result).toContain("• item A");
    expect(result).toContain("• item B");
    expect(result).toContain("<code>code</code>");
  });

  it("returns valid output for a string with unbalanced markdown markers", () => {
    // Must not throw; stray markers pass through as literal chars (already escaped).
    expect(() => markdownToTelegramHtml("**unclosed bold")).not.toThrow();
    expect(() => markdownToTelegramHtml("text with a lone _underscore here")).not.toThrow();
  });
});

// ─── Telegram adapter — HTML send + plain-text fallback ──────────────────────

describe("telegram adapter — HTML formatting and fallback", () => {
  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: async () => body } as unknown as Response;
  }

  it("deliver sends parse_mode HTML for plain text (no markdown in payload)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), ...body });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }) as unknown as typeof fetch;

    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl,
    });
    await adapter.deliver("hello world");
    const send = calls.find((c) => String(c.url).endsWith("/sendMessage"));
    expect(send?.parse_mode).toBe("HTML");
    expect(send?.text).toBe("hello world");
  });

  it("deliver converts markdown to HTML in the outbound payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: String(url), ...body });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }) as unknown as typeof fetch;

    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl,
    });
    await adapter.deliver("**bold** and `code`");
    const send = calls.find((c) => String(c.url).endsWith("/sendMessage"));
    expect(send?.parse_mode).toBe("HTML");
    expect(String(send?.text)).toContain("<b>bold</b>");
    expect(String(send?.text)).toContain("<code>code</code>");
  });

  it("deliver falls back to plain text when Telegram returns a parse-entities error", async () => {
    const logs: string[] = [];
    let callCount = 0;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // First call (HTML): simulate Telegram parse error.
      if (body.parse_mode === "HTML") {
        return jsonResponse(
          { ok: false, description: "Bad Request: can't parse entities" },
          false,
          400,
        );
      }
      // Second call (plain text fallback): succeed.
      return jsonResponse({ ok: true, result: { message_id: 2 } });
    }) as unknown as typeof fetch;

    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["111"],
      fetchImpl,
      log: (m) => logs.push(m),
    });
    // Must not throw — fallback must absorb the error.
    await expect(adapter.deliver("**bad entity**")).resolves.toBeUndefined();
    // Two API calls: one HTML attempt + one plain-text retry.
    expect(callCount).toBe(2);
    expect(logs.some((l) => l.includes("retrying as plain text"))).toBe(true);
  });
});

// ─── Discord adapter ─────────────────────────────────────────────────────────

describe("discord adapter", () => {
  it("Hello triggers Identify; MESSAGE_CREATE in an allowed channel arrives", async () => {
    const ws = new FakeWS();
    const received: InboundMessage[] = [];
    const adapter = createDiscordAdapter({
      botToken: "BOT",
      allowedChannelIds: ["chan1"],
      wsFactory: () => ws,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await adapter.start((m) => received.push(m));

    ws.emitMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
    const identify = ws.frames().find((f) => f.op === 2);
    expect(identify).toBeTruthy();
    expect((identify?.d as { token: string }).token).toBe("BOT");

    ws.emitMessage(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "MESSAGE_CREATE",
        d: { channel_id: "chan1", author: { id: "u1" }, content: "hi discord" },
      }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("hi discord");

    // A non-allowlisted channel and a bot author are both ignored.
    ws.emitMessage(
      JSON.stringify({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: { channel_id: "other", author: { id: "u2" }, content: "x" },
      }),
    );
    ws.emitMessage(
      JSON.stringify({
        op: 0,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          channel_id: "chan1",
          author: { id: "b", bot: true },
          content: "y",
        },
      }),
    );
    expect(received).toHaveLength(1);
    await adapter.stop();
  });

  it("deliver POSTs to the channel-messages endpoint", async () => {
    const calls: Array<{ url: string; content: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        content: (JSON.parse(String(init?.body)) as { content: string }).content,
      });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const adapter = createDiscordAdapter({
      botToken: "BOT",
      allowedChannelIds: ["chan1"],
      wsFactory: () => new FakeWS(),
      fetchImpl,
    });
    await adapter.deliver("from agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/channels/chan1/messages");
    expect(calls[0]?.content).toBe("from agent");
  });

  it("rejects an empty channel allowlist (zero-trust)", () => {
    expect(() => createDiscordAdapter({ botToken: "B", allowedChannelIds: [] })).toThrow(
      /non-empty/,
    );
  });
});

// ─── Slack adapter ───────────────────────────────────────────────────────────

describe("slack adapter", () => {
  it("connects, ACKs an event envelope, receives the message", async () => {
    const ws = new FakeWS();
    const received: InboundMessage[] = [];
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/apps.connections.open")) {
        return jsonResponse({ ok: true, url: "wss://fake.slack/ws" });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter({
      appToken: "xapp-1",
      botToken: "xoxb-1",
      allowedChannelIds: ["C1"],
      wsFactory: () => ws,
      fetchImpl,
    });
    await adapter.start((m) => received.push(m));

    ws.emitMessage(JSON.stringify({ type: "hello" }));
    ws.emitMessage(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-1",
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "U1",
            text: "hi slack",
          },
        },
      }),
    );
    const ack = ws.frames().find((f) => f.envelope_id === "env-1");
    expect(ack).toBeTruthy();
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("hi slack");

    // Non-allowlisted channel + a bot message are ignored.
    ws.emitMessage(
      JSON.stringify({
        type: "events_api",
        envelope_id: "e2",
        payload: {
          event: { type: "message", channel: "OTHER", user: "U", text: "x" },
        },
      }),
    );
    ws.emitMessage(
      JSON.stringify({
        type: "events_api",
        envelope_id: "e3",
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "U",
            text: "y",
            bot_id: "B1",
          },
        },
      }),
    );
    expect(received).toHaveLength(1);
    await adapter.stop();
  });

  it("deliver calls chat.postMessage", async () => {
    const calls: Array<{ channel: string; text: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/chat.postMessage")) {
        calls.push(JSON.parse(String(init?.body)) as { channel: string; text: string });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true, url: "wss://x" });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter({
      appToken: "xapp",
      botToken: "xoxb",
      allowedChannelIds: ["C1"],
      wsFactory: () => new FakeWS(),
      fetchImpl,
    });
    await adapter.deliver("agent says hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe("C1");
    expect(calls[0]?.text).toBe("agent says hi");
  });

  it("rejects missing tokens and empty allowlists (zero-trust)", () => {
    expect(() =>
      createSlackAdapter({
        appToken: "",
        botToken: "xoxb",
        allowedChannelIds: ["C1"],
      }),
    ).toThrow(/required/);
    expect(() =>
      createSlackAdapter({
        appToken: "xapp",
        botToken: "xoxb",
        allowedChannelIds: [],
      }),
    ).toThrow(/non-empty/);
  });
});

// ─── Protocol depth (T4 hardening) ───────────────────────────────────────────

describe("gateway — protocol depth", () => {
  it("discord answers a server-requested heartbeat (op 1)", async () => {
    const ws = new FakeWS();
    const adapter = createDiscordAdapter({
      botToken: "BOT",
      allowedChannelIds: ["chan1"],
      wsFactory: () => ws,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await adapter.start(() => {});
    ws.emitMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
    // A dispatch frame carries a sequence number the heartbeat must echo.
    ws.emitMessage(JSON.stringify({ op: 0, s: 7, t: "READY", d: {} }));
    ws.sent.length = 0; // drop the Identify frame from the record
    ws.emitMessage(JSON.stringify({ op: 1 })); // server asks for a heartbeat
    const hb = ws.frames().find((f) => f.op === 1);
    expect(hb).toBeTruthy();
    expect(hb?.d).toBe(7);
    await adapter.stop();
  });

  it("discord stop() closes the socket and clears the heartbeat", async () => {
    const ws = new FakeWS();
    const adapter = createDiscordAdapter({
      botToken: "BOT",
      allowedChannelIds: ["chan1"],
      wsFactory: () => ws,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await adapter.start(() => {});
    ws.emitMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }));
    await adapter.stop();
    expect(ws.closed).toBe(true);
  });

  it("discord deliver logs a non-OK HTTP response", async () => {
    const logs: string[] = [];
    const adapter = createDiscordAdapter({
      botToken: "BOT",
      allowedChannelIds: ["chan1"],
      wsFactory: () => new FakeWS(),
      fetchImpl: (async () => jsonResponse({}, false, 403)) as unknown as typeof fetch,
      log: (m) => logs.push(m),
    });
    await adapter.deliver("x");
    expect(logs.some((l) => l.includes("403"))).toBe(true);
  });

  it("slack closes the socket on a disconnect frame", async () => {
    const ws = new FakeWS();
    const adapter = createSlackAdapter({
      appToken: "xapp",
      botToken: "xoxb",
      allowedChannelIds: ["C1"],
      wsFactory: () => ws,
      fetchImpl: (async () =>
        jsonResponse({ ok: true, url: "wss://x" })) as unknown as typeof fetch,
    });
    await adapter.start(() => {});
    ws.emitMessage(JSON.stringify({ type: "disconnect" }));
    expect(ws.closed).toBe(true);
    await adapter.stop();
  });

  it("slack deliver logs a Slack API error (ok:false)", async () => {
    const logs: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/chat.postMessage")) {
        return jsonResponse({ ok: false, error: "channel_not_found" });
      }
      return jsonResponse({ ok: true, url: "wss://x" });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter({
      appToken: "xapp",
      botToken: "xoxb",
      allowedChannelIds: ["C1"],
      wsFactory: () => new FakeWS(),
      fetchImpl,
      log: (m) => logs.push(m),
    });
    await adapter.deliver("x");
    expect(logs.some((l) => l.includes("channel_not_found"))).toBe(true);
  });

  it("a verbose gateway broadcasts tool events", async () => {
    const hub = createRemoteControlHub();
    const adapter = new FakeAdapter();
    const gw = createGateway({
      hub,
      adapters: [adapter],
      verbose: true,
      greeting: false,
    });
    await gw.start();
    hub.emit(
      makeEvent("tool.call.end", {
        callId: "c",
        toolName: "run_bash",
        ok: true,
        resultPreview: "done",
      }),
    );
    await tick();
    expect(adapter.delivered.some((d) => d.includes("run_bash"))).toBe(true);
    await gw.stop();
  });

  it("one adapter failing to start does not sink the others", async () => {
    const hub = createRemoteControlHub();
    const good = new FakeAdapter("good");
    const failing: GatewayAdapter = {
      platform: "failing",
      start: async () => {
        throw new Error("boom");
      },
      deliver: async () => {},
      stop: async () => {},
    };
    const gw = createGateway({
      hub,
      adapters: [failing, good],
      greeting: false,
    });
    await expect(gw.start()).resolves.toBeUndefined();
    expect(good.started).toBe(true);
    await gw.stop();
  });
});
