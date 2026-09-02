/**
 * remote/gateway/gateway — the multi-platform Gateway.
 *
 * One running agent session, several messaging surfaces. The gateway:
 *   - subscribes to the `RemoteControlHub` event stream, renders each event
 *     for chat, and broadcasts it to every adapter;
 *   - receives inbound messages from every adapter, parses control commands
 *     (/approve, /reject, /whisper, /status) and otherwise enqueues the text
 *     into the hub's `InstructionInbox` — mid-run steering from any platform.
 *
 * This is the Hermes-style assistant gateway built entirely on the T1-T3
 * primitives: the same agent is reachable from the CLI, Telegram, Discord and
 * Slack at once, with no surface-specific agent logic.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

import type { RemoteApprovalChannel } from "../approval.js";
import type { SessionEvent } from "../events.js";
import type { RemoteControlPort } from "../port.js";
import { renderEventForChat } from "./render.js";
import type { ApprovalCallback, GatewayAdapter, GatewayLogger, InboundMessage } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

const DEFAULT_GREETING =
  "🟢 preste gateway online — send a message to steer the agent. " +
  "Commands: /approve · /reject · /whisper <hint> · /status · /revive <id>";

/** @public */
export interface GatewayOptions {
  /**
   * The remote-control hub: inbound instructions land in its `inbox`,
   * outbound `SessionEvent`s stream from its `subscribe`.
   */
  hub: RemoteControlPort;
  /** Platform adapters to multiplex. */
  adapters: GatewayAdapter[];
  /**
   * Optional HITL channel — chat `/approve` and `/reject` commands route
   * here. Without it those commands are logged and ignored.
   */
  approvalChannel?: RemoteApprovalChannel;
  /**
   * Optional out-of-band STOP hook. A chat `/stop` (or `/cancel`) command calls
   * it IMMEDIATELY on the receive path — not via the inbox — so it can abort a
   * long-running in-flight tool (e.g. a spawn_dag) while the agent loop is
   * blocked inside that tool. Returns true if something was actually aborted.
   * Absent = `/stop` is treated as ordinary input (enqueued).
   */
  onStop?: () => boolean;
  /**
   * Optional revive hook for a parked (timed-out) approval. A chat
   * `/revive <id>` command calls it on the receive path. Returns true when a
   * parked request was actually revived (so the NEXT matching tool call is
   * approved on retry), false when the id is unknown or its window expired.
   * Absent = `/revive` is treated as ordinary input (enqueued).
   */
  onRevive?: (id: string) => boolean;
  /** Render tool.* events too (chattier). Default false. */
  verbose?: boolean;
  /**
   * Message broadcast to every platform once the gateway is up. Set `false`
   * to stay silent. Default: a short usage hint.
   */
  greeting?: string | false;
  /** Logger. Default no-op. */
  log?: GatewayLogger;
}

/** @public */
export interface GatewayHandle {
  /** Start every adapter + begin forwarding the event stream. Idempotent. */
  start(): Promise<void>;
  /** Stop every adapter + detach from the hub. Idempotent. */
  stop(): Promise<void>;
  /** Platform slugs currently multiplexed. */
  readonly platforms: string[];
}

/**
 * Create a Gateway over a RemoteControlHub.
 * @public
 */
export function createGateway(opts: GatewayOptions): GatewayHandle {
  const log = opts.log ?? NOOP_LOGGER;
  const renderOpts = { verbose: opts.verbose ?? false };
  const greeting = opts.greeting === false ? null : (opts.greeting ?? DEFAULT_GREETING);

  let started = false;
  let unsubscribe: (() => void) | null = null;
  /** Most recent HITL request id — the target of a bare /approve or /reject. */
  let lastPendingHitlId: string | null = null;

  async function deliverAll(text: string): Promise<void> {
    await Promise.all(
      opts.adapters.map((a) =>
        a.deliver(text).catch((err) => {
          log(`${a.platform}: deliver failed — ${(err as Error).message}`);
        }),
      ),
    );
  }

  /** The shared verdict path ; every approve/reject (text OR button) lands here.
   * `scope` is additive (uplift-C, sprint-939) ; a bare button tap or a plain
   * "/approve" never sets it, so `channel.resolve`'s default (no standing
   * grant) is unchanged. */
  function resolveApproval(
    id: string,
    approved: boolean,
    by: string,
    scope?: "session" | "always",
  ): void {
    const channel = opts.approvalChannel;
    if (!channel) {
      log("gateway: approval verdict ignored ; no HITL channel wired");
      return;
    }
    if (!channel.resolve(id, approved, by, "", scope)) {
      log(`gateway: HITL ${id} could not be resolved (already settled?)`);
    }
  }

  function routeApproval(approved: boolean, by: string, text: string): void {
    if (!opts.approvalChannel) {
      log("gateway: approval command ignored — no HITL channel wired");
      return;
    }
    // "/approve <id>" targets an explicit request; bare "/approve" the latest.
    // "/approve session" or "/approve always" is a SCOPE verb, not an id — it
    // still targets the latest pending request, but also asks the resolved
    // verdict to carry a standing-grant scope (uplift-C, sprint-939).
    const parts = text.trim().split(/\s+/);
    const second = parts.length > 1 ? parts[1] : undefined;
    const scope: "session" | "always" | undefined =
      second === "session" || second === "always" ? second : undefined;
    const explicitId = scope === undefined ? second : undefined;
    const id = explicitId ?? lastPendingHitlId;
    if (!id) {
      log("gateway: approval command ignored — no pending HITL request");
      return;
    }
    resolveApproval(id, approved, by, scope);
  }

  /**
   * A button tap from an adapter. The adapter has already gated the chat
   * against its allowlist (same gate as a message) ; the verdict carries the
   * exact target id, so it routes straight through the shared resolve path,
   * identical to a `/approve <id>` text command.
   */
  function onApprovalCallback(cb: ApprovalCallback): void {
    const by = `${cb.platform}:${cb.chatId}`;
    resolveApproval(cb.approvalId, cb.approved, by);
  }

  function onInbound(msg: InboundMessage): void {
    const source = `${msg.platform}:${msg.chatId}`;
    const text = msg.text.trim();
    if (text === "") return;
    const lower = text.toLowerCase();

    if (lower === "/approve" || lower === "/yes" || lower.startsWith("/approve ")) {
      routeApproval(true, source, text);
      return;
    }
    if (lower === "/reject" || lower === "/no" || lower.startsWith("/reject ")) {
      routeApproval(false, source, text);
      return;
    }
    if (lower.startsWith("/whisper ")) {
      opts.hub.inbox.enqueue(text.slice(9).trim(), source, true);
      return;
    }
    if (lower === "/status") {
      const s = opts.hub.state();
      void deliverAll(
        `📊 ${s.status} — step ${s.stepCount}, ` +
          `$${s.costUsd.toFixed(4)}, ${s.pendingHitl} pending approval(s)`,
      );
      return;
    }
    if (lower === "/stop" || lower === "/cancel") {
      // Out-of-band abort: runs on the receive path, so it fires even while the
      // agent loop is blocked inside a long-running tool (e.g. spawn_dag).
      const aborted = opts.onStop?.() ?? false;
      void deliverAll(aborted ? "⏹️ stopping the in-flight run." : "⏹️ nothing running to stop.");
      return;
    }
    if (lower === "/revive" || lower.startsWith("/revive ")) {
      // Revive a parked (timed-out) approval so the NEXT matching tool call is
      // approved on retry. Fail-closed stays intact: this primes the
      // coalescence key, it never resurrects the original settled request.
      const parts = text.trim().split(/\s+/);
      const id = parts.length > 1 ? parts[1] : undefined;
      if (!id) {
        void deliverAll("↩️ usage: /revive <request-id> (from the ⏸ parked notice).");
        return;
      }
      const revived = opts.onRevive?.(id) ?? false;
      void deliverAll(
        revived
          ? `↩️ revived ${id} — it will be approved on the next retry.`
          : `↩️ nothing to revive for ${id} (unknown id or the 1h window expired).`,
      );
      return;
    }
    // Plain message → steering instruction injected mid-run.
    opts.hub.inbox.enqueue(text, source, false);
  }

  /**
   * Broadcast a HITL prompt: an adapter that renders tappable verdicts
   * (`deliverApproval`) gets the structured prompt + buttons; any other adapter
   * gets the identical `text` via `deliver`, so the founder always sees at
   * least the text flow. The rendered `text` already carries the
   * "reply /approve or /reject" hint, which stays valid on every surface.
   */
  async function deliverApprovalPrompt(
    requestId: string,
    action: string,
    context: string,
    text: string,
  ): Promise<void> {
    await Promise.all(
      opts.adapters.map((a) => {
        const p = a.deliverApproval
          ? a.deliverApproval({ id: requestId, action, context, text })
          : a.deliver(text);
        return p.catch((err) => {
          log(`${a.platform}: approval delivery failed ; ${(err as Error).message}`);
        });
      }),
    );
  }

  function onEvent(event: SessionEvent): void {
    if (event.type === "CUSTOM_HITL_REQUEST" || event.type === "hitl.request") {
      const d = event.data as {
        requestId: string;
        action: string;
        context: string;
      };
      lastPendingHitlId = d.requestId;
      const text = renderEventForChat(event, renderOpts);
      if (text !== null) {
        void deliverApprovalPrompt(d.requestId, d.action, d.context, text);
      }
      return;
    }
    if (
      (event.type === "CUSTOM_HITL_RESOLVED" || event.type === "hitl.resolved") &&
      lastPendingHitlId === (event.data as { requestId: string }).requestId
    ) {
      lastPendingHitlId = null;
    }
    const text = renderEventForChat(event, renderOpts);
    if (text !== null) void deliverAll(text);
  }

  return {
    get platforms(): string[] {
      return opts.adapters.map((a) => a.platform);
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      unsubscribe = opts.hub.subscribe(onEvent);
      // One platform failing to start must never sink the others.
      await Promise.all(
        opts.adapters.map((a) =>
          a.start(onInbound, onApprovalCallback).catch((err) => {
            log(`${a.platform}: start failed — ${(err as Error).message}`);
          }),
        ),
      );
      log(`gateway: up on ${opts.adapters.map((a) => a.platform).join(", ") || "(no adapters)"}`);
      if (greeting) await deliverAll(greeting);
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      await Promise.all(
        opts.adapters.map((a) =>
          a.stop().catch((err) => {
            log(`${a.platform}: stop failed — ${(err as Error).message}`);
          }),
        ),
      );
    },
  };
}
