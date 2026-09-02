/**
 * remote/gateway/types — the multi-platform gateway ports.
 *
 * The gateway makes ONE running agent session reachable from several
 * messaging surfaces at once (Telegram, Discord, Slack — and the local CLI).
 * Each surface is a `GatewayAdapter`: it normalizes inbound platform messages
 * into the SDK's `InstructionInbox` and delivers the agent's rendered
 * `SessionEvent` stream back out.
 *
 * Transport-agnostic by design — the same port/transport split the SDK
 * already uses for HITL (`ApprovalChannel`) and remote-control
 * (`RemoteControlPort`). An adapter owns one platform's wire protocol; the
 * `Gateway` (see gateway.ts) owns the routing.
 *
 * @public @since 2.14.0 — preste remote-control T4
 */

/**
 * A non-text input carried on an inbound message (multimodal ; Beyond-Hermes).
 * Transport-layer shape ; the gateway maps it to the SDK `ImageAttachment` when
 * building the agent's ChatMessage. `kind` discriminates for future media.
 */
export interface InboundAttachment {
  kind: "image";
  /** IANA media type, e.g. "image/jpeg". */
  mediaType: string;
  /** Base64-encoded bytes (NO `data:` prefix). */
  dataBase64: string;
}

/**
 * One inbound message normalized from a platform-specific payload.
 * @public
 */
export interface InboundMessage {
  /** Platform slug — "telegram" | "discord" | "slack" | "cli". */
  platform: string;
  /** Platform-specific conversation id (chat / channel). */
  chatId: string;
  /** Platform-specific sender id. */
  userId: string;
  /** The raw message text (a media message carries its caption here, or ""). */
  text: string;
  /**
   * Optional non-text inputs (e.g. a Telegram photo). Additive + optional: a
   * text-only message omits it, so every existing consumer is unaffected. The
   * gateway forwards these to a vision-capable model when wired (the inbox/loop
   * wire-through is a separate slice ; today an adapter populates them and the
   * SDK LiteLLM adapter can already consume the mapped ChatMessage attachments).
   */
  attachments?: InboundAttachment[];
  /** ISO8601 receive time. */
  ts: string;
}

/**
 * A structured HITL approval prompt ; the data an adapter needs to render a
 * tappable verdict surface (e.g. Telegram inline keyboard) instead of a bare
 * "reply /approve or /reject" text line.
 *
 * `text` is the already-rendered chat string (the same one a text-only adapter
 * would receive via `deliver`), so an adapter can show identical wording above
 * its buttons. `id`, `action`, `context` are the structured fields a button
 * encodes its `callback_data` against.
 * @public
 */
export interface ApprovalPrompt {
  /** The HITL request id ; the target of a verdict (`channel.resolve(id,...)`). */
  id: string;
  /** Short action label (e.g. the tool name being gated). */
  action: string;
  /** Human context for the verdict (e.g. the command + rationale). */
  context: string;
  /** Pre-rendered chat text ; identical to the text-flow `deliver` payload. */
  text: string;
}

/**
 * A normalized inbound verdict from a button tap ; the structured equivalent of
 * a `/approve` / `/reject` text message. The gateway routes it through the SAME
 * `RemoteApprovalChannel.resolve` path as the text command.
 * @public
 */
export interface ApprovalCallback {
  /** Platform slug ; "telegram" | "discord" | "slack". */
  platform: string;
  /** Platform-specific conversation id (chat / channel). */
  chatId: string;
  /** Platform-specific sender id. */
  userId: string;
  /** The HITL request id this verdict targets. */
  approvalId: string;
  /** The verdict ; true = approve, false = reject. */
  approved: boolean;
  /** ISO8601 receive time. */
  ts: string;
}

/**
 * One messaging surface. An adapter owns a single platform's wire protocol:
 * it receives messages (`start`) and delivers agent output (`deliver`).
 * @public
 */
export interface GatewayAdapter {
  /** Platform slug — unique per adapter instance. */
  readonly platform: string;
  /**
   * Begin receiving. `onMessage` is invoked for every inbound message that
   * passes the adapter's allowlist. Resolves once the adapter is live (the
   * receive loop runs in the background — it is NOT awaited here).
   *
   * `onApprovalCallback` is OPTIONAL and only relevant to adapters that render
   * tappable verdict surfaces (see `deliverApproval`): the adapter invokes it
   * with a normalized `ApprovalCallback` when a button is tapped, after the
   * same allowlist gate it applies to messages. Adapters that do not implement
   * button verdicts simply ignore it ; the text `/approve` flow is unaffected.
   */
  start(
    onMessage: (msg: InboundMessage) => void,
    onApprovalCallback?: (cb: ApprovalCallback) => void,
  ): Promise<void>;
  /** Deliver one rendered chunk of agent output to the platform. */
  deliver(text: string): Promise<void>;
  /**
   * OPTIONAL: deliver a HITL approval prompt as a tappable verdict surface
   * (e.g. a Telegram inline keyboard) rather than a bare text line. Adapters
   * that do not implement this are sent the prompt's `text` via `deliver`
   * instead, so the founder always gets at least the text flow.
   *
   * When implemented, a tap MUST resolve through the gateway's
   * `onApprovalCallback` path ; the SAME `RemoteApprovalChannel.resolve` route
   * a `/approve` text command uses.
   */
  deliverApproval?(prompt: ApprovalPrompt): Promise<void>;
  /** Stop receiving and release the transport. Idempotent. */
  stop(): Promise<void>;
}

/** A logging sink — the gateway and adapters report status here. */
export type GatewayLogger = (msg: string) => void;

/** Discard-everything logger — the default. */
export const NOOP_LOGGER: GatewayLogger = () => {
  /* discard */
};

/**
 * Minimal WHATWG-WebSocket surface. Node's global `WebSocket` (>=22), a
 * browser `WebSocket`, and a test fake all satisfy it. Injecting this keeps
 * the WS-based adapters (Discord, Slack) unit-testable without a network and
 * keeps the SDK free of a hard `ws` dependency.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Builds a `WebSocketLike` for a given URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Default WS factory — uses the runtime's global `WebSocket` (Node >=22,
 * browsers). Throws a clear message if none exists so a Node <22 consumer
 * knows to pass an explicit factory backed by the `ws` package.
 */
export function defaultWebSocketFactory(url: string): WebSocketLike {
  const WS = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => WebSocketLike;
    }
  ).WebSocket;
  if (!WS) {
    throw new Error(
      "no global WebSocket in this runtime — pass an explicit wsFactory " +
        "(Node <22 needs the `ws` package)",
    );
  }
  return new WS(url);
}
