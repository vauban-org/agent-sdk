/**
 * Publisher registry ; maps channel string to PublisherPort instance.
 *
 * The orchestrator dispatches by `payload.platform` (X), `payload.channel`,
 * or the action_type (publish_article → rempart, send_cold_mail → email).
 * The registry centralizes that mapping.
 *
 * Registry stays in publishers/ since it is an orchestration concept,
 * not a port or adapter.
 *
 * @public
 */

import type { PublisherPort } from "../ports/publisher.js";

/** @public */
export interface PublisherRegistryInput {
  readonly x?: PublisherPort;
  readonly email?: PublisherPort;
  readonly discord?: PublisherPort;
  readonly github?: PublisherPort;
  readonly rempart?: PublisherPort;
  readonly linkedin?: PublisherPort;
  /** Open extension point ; extra publishers keyed by channel string. */
  readonly extras?: Readonly<Record<string, PublisherPort>>;
}

/** @public */
export interface PublisherRegistry {
  /** Lookup by exact channel string. Returns null if unregistered. */
  get(channel: string): PublisherPort | null;
  /**
   * Pick the right publisher for the given action_type + payload shape.
   * Falls back to channel-based lookup ; returns null when no match.
   *
   * Decision order :
   *   1. `payload.platform` ; explicit channel string overrides action_type.
   *   2. action_type ; publish_article → rempart, send_*_mail → email.
   *   3. null ; caller dispatches to DLQ.
   */
  pick(
    actionType: string,
    payload: Record<string, unknown> | null | undefined,
  ): PublisherPort | null;
  /** All registered channels (for diagnostics + test). */
  channels(): readonly string[];
}

const ACTION_TYPE_DEFAULT_CHANNEL: Readonly<Record<string, string>> = {
  publish_article: "rempart",
  send_cold_mail: "email",
  send_follow_up_mail: "email",
};

/** @public */
export function createPublisherRegistry(input: PublisherRegistryInput): PublisherRegistry {
  const map = new Map<string, PublisherPort>();
  for (const [channel, pub] of Object.entries({
    x: input.x,
    email: input.email,
    discord: input.discord,
    github: input.github,
    rempart: input.rempart,
    linkedin: input.linkedin,
  })) {
    if (pub) map.set(channel, pub);
  }
  if (input.extras) {
    for (const [channel, pub] of Object.entries(input.extras)) {
      if (pub) map.set(channel, pub);
    }
  }

  return {
    get(channel) {
      return map.get(channel) ?? null;
    },
    pick(actionType, payload) {
      const explicit =
        payload && typeof payload.platform === "string" ? (payload.platform as string) : undefined;
      if (explicit) {
        return map.get(explicit) ?? null;
      }
      const channelFromAction = ACTION_TYPE_DEFAULT_CHANNEL[actionType];
      if (channelFromAction) {
        return map.get(channelFromAction) ?? null;
      }
      return null;
    },
    channels() {
      return Array.from(map.keys());
    },
  };
}
