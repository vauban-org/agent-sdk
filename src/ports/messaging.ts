/**
 * MessagingChannelPort — SDK v0.16.0 (sprint-615:quick-2)
 *
 * Generic channel abstraction for alerts and messages.
 * HITL (human-in-the-loop approval) is intentionally excluded;
 * that belongs to HITLPort per plan v6 §3.5.
 *
 * @public
 */

/**
 * Alert severity levels, ordered by escalation.
 * @public
 */
export type AlertLevel = "info" | "warn" | "error" | "critical";

/**
 * Port for sending alerts and messages via any channel.
 *
 * Implementations: TelegramChannel, SlackChannel, DiscordChannel,
 * ConsoleChannel, MCPChannel.
 *
 * @public
 */
export interface MessagingChannelPort {
  /**
   * Send a structured alert to the default channel for this adapter.
   *
   * @param level - Severity: info < warn < error < critical
   * @param title - Short summary (shown prominently)
   * @param body  - Detailed message body
   */
  sendAlert(level: AlertLevel, title: string, body: string): Promise<void>;

  /**
   * Send a free-form message to a specific target (channel, chat, user).
   *
   * @param target - Channel/chat/user identifier (adapter-specific format)
   * @param text   - Message content
   * @throws {InvalidTargetError} If target is empty or invalid
   */
  sendMessage(target: string, text: string): Promise<void>;
}

/**
 * Thrown when `target` is empty or structurally invalid for the adapter.
 *
 * @public
 */
export class InvalidTargetError extends Error {
  constructor(
    message: string,
    public readonly target: string,
  ) {
    super(message);
    this.name = "InvalidTargetError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
