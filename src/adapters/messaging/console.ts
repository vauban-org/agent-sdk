/**
 * ConsoleChannel — MessagingChannelPort adapter for local console output.
 *
 * Designed for tests and local development. No external API calls.
 * Constructor requires no arguments (defaultStream = process.stdout).
 *
 * ANSI color codes:
 *   info     → cyan
 *   warn     → yellow
 *   error    → red
 *   critical → bright red + bold
 *
 * @public
 */

import type { AlertLevel, MessagingChannelPort } from "../../ports/messaging.js";
import { InvalidTargetError } from "../../ports/messaging.js";

/** ANSI escape codes per alert level. */
const LEVEL_ANSI: Record<AlertLevel, string> = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  critical: "\x1b[1m\x1b[31m", // bold + red
};

const ANSI_RESET = "\x1b[0m";

/** @public */
export interface ConsoleChannelConfig {
  /**
   * Output stream. Defaults to `process.stdout` when not provided.
   * Inject a mock stream in tests to capture output.
   */
  stream?: NodeJS.WriteStream;
}

/** @public */
export class ConsoleChannel implements MessagingChannelPort {
  readonly #stream: NodeJS.WriteStream;

  /**
   * @param config - Optional config. All fields optional — usable as `new ConsoleChannel()`.
   */
  constructor(config: ConsoleChannelConfig = {}) {
    this.#stream = config.stream ?? process.stdout;
  }

  async sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
    const ansi = LEVEL_ANSI[level];
    const levelTag = `[${level.toUpperCase()}]`;
    this.#write(`${ansi}${levelTag} ${title}${ANSI_RESET}\n${body}\n`);
  }

  async sendMessage(target: string, text: string): Promise<void> {
    if (!target || target.trim() === "") {
      throw new InvalidTargetError(
        "ConsoleChannel.sendMessage requires a non-empty target",
        target,
      );
    }
    this.#write(`[MSG→${target.trim()}] ${text}\n`);
  }

  #write(line: string): void {
    this.#stream.write(line);
  }
}
