/**
 * PublisherPort ; host adapter interface for any agent channel that ships
 * content to an external surface (X, LinkedIn, email, Rempart, Discord,
 * GitHub, ...).
 *
 * Design (Brain entry d8df4ed7 follow-up #2) :
 *   - Each publisher owns one channel and one transport.
 *   - All publishers return a uniform `PublishResult` so the orchestrator
 *     can dispatch by `payload.platform` and aggregate results without
 *     special-casing.
 *   - `publish` is async and idempotent ; callers MUST pass a stable
 *     `actionId` so the publisher can dedupe retries.
 *
 * Canonical location : src/ports/publisher.ts (moved from src/publishers/types.ts in 1.16.x).
 * Backward-compat re-export remains in src/publishers/types.ts ; removed in 2.0.
 *
 * @public
 */

import type { AgentPersona } from "../identity/persona-schema.js";

/**
 * Channel string ; the routing key the orchestrator uses to dispatch.
 * @public
 */
export type PublisherChannel =
  | "x"
  | "linkedin"
  | "rempart"
  | "email"
  | "discord"
  | "github"
  | string;

/**
 * Status emitted by every publisher.
 * @public
 */
export type PublishStatus = "published" | "dlq" | "failed" | "partial";

/** @public */
export interface PublishContext {
  readonly campaignSlug: string;
  readonly actionId: string;
}

/** @public */
export interface PublishInput {
  readonly payload: Record<string, unknown>;
  readonly persona?: AgentPersona;
  readonly context: PublishContext;
}

/** @public */
export interface PublishResult {
  /** Outcome of the publish attempt. */
  readonly status: PublishStatus;
  /** Canonical URL of the published artifact when one exists (X post, GitHub comment, ...). */
  readonly posted_url?: string;
  /** Identifier of the published artifact (tweet id, message id, ...). */
  readonly posted_id?: string;
  /** ISO-8601 wall-clock at the moment the publisher considered the artifact live. */
  readonly posted_at?: string;
  /** Channel string ; copy of `publisher.channel` for downstream telemetry. */
  readonly channel: string;
  /** Error message ; populated when status=failed. */
  readonly error?: string;
  /** Reason ; populated when status=dlq or status=partial. */
  readonly reason?: string;
  /**
   * X thread partial-publish escalation ; 1-based indexes of tweets that
   * X rejected after retry. The root tweet is index 1 ; the gate caller
   * inspects this on status=published to decide whether to escalate.
   * (Brain follow-up d8df4ed7 ; campaign vauban-zkpay-starknet-launch 2026-05-20.)
   */
  readonly partial_failure_tweets?: number[];
}

/** @public */
export interface PublisherPort {
  /** Channel string ; routing key consumed by the orchestrator. */
  readonly channel: PublisherChannel;
  /** True when the publisher has the credentials/config it needs. */
  isConfigured(): Promise<boolean>;
  /** Publish the payload ; never throws ; surfaces failure via PublishResult. */
  publish(input: PublishInput): Promise<PublishResult>;
}
