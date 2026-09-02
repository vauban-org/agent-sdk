/**
 * CitadelCampaignPort — host adapter for Citadel campaign operations.
 *
 * SSOT runtime for cross-Vauban campaigns. Used by Forge orchestrator,
 * Preste (future), and any product that needs to manage GTM campaigns.
 *
 * Source: forge/docs/superpowers/specs/2026-05-18-campaign-orchestrator-design.md
 */

import type { ActionContext } from "./citadel-action.js";

/** @public */
export type CampaignActionType =
  | "publish_article"
  | "publish_social_post"
  | "send_cold_mail"
  | "send_follow_up_mail"
  | "engage_target"
  | "manual_review";

/** @public */
export type CampaignActionStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";

/** @public */
export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";

/** @public */
export type ContactDirection = "inbound" | "outbound";

/** @public */
export interface CampaignInput {
  readonly slug: string;
  readonly name: string;
  readonly product: string;
  readonly objective: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** @public */
export interface CampaignRef {
  readonly campaign_id: string;
  readonly slug: string;
  readonly status: CampaignStatus;
  readonly created_at: Date;
}

/** @public */
export interface CampaignActionInput {
  readonly campaign_slug: string;
  readonly action_type: CampaignActionType;
  readonly title: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority?: number;
  readonly due_date?: string;
  readonly contact_id?: string;
  readonly idempotency_key: string;
}

/** @public */
export interface CampaignActionRef {
  readonly action_id: string;
  readonly campaign_slug: string;
  readonly action_type: CampaignActionType;
  readonly status: CampaignActionStatus;
  readonly priority: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly contact_id?: string;
  /** Human-readable action name from Citadel. Used by the auto-classifier to
   *  infer the correct action_type when the stored value is "manual_review". */
  readonly name?: string;
}

/** @public */
export interface ActionFilter {
  readonly campaign_slug?: string;
  readonly status?: CampaignActionStatus;
  readonly action_type?: CampaignActionType;
  readonly due_before?: string;
  /**
   * Server-side filter on scheduled_at. Forwarded to MCP get_campaign_actions
   * as RFC3339 string (or as-is if already a string). Citadel REST/MCP surface
   * accepts this filter since commit 44391dc (sprint S3).
   *
   * Accepts Date instance or RFC3339 string for caller ergonomics.
   * Backwards-compat: SDK 1.13 callers that omit this filter continue to work.
   */
  readonly scheduled_before?: Date | string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Patch input for updateAction. All fields optional ; only provided fields
 * are forwarded to MCP update_campaign_action. Caller controls partial-update
 * semantics.
 * @public
 */
export interface CampaignActionPatch {
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly status?: CampaignActionStatus;
  readonly notes?: string;
  readonly publish_evidence?: Readonly<Record<string, unknown>>;
  readonly scheduled_at?: string;
  readonly phase?: string;
}

/**
 * Patch input for an existing campaign. Optional fields drive partial updates
 * via MCP update_campaign. cadence_plan supports campaigns with multi-phase
 * scheduling (added 1.14.0).
 * @public
 */
export interface CampaignPatch {
  readonly name?: string;
  readonly status?: CampaignStatus;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly cadence_plan?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** @public */
export interface ActionCompletion {
  readonly action_id: string;
  readonly outcome: "success" | "failure" | "skipped";
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly worker_agent_id: string;
}

/** @public */
export interface ContactInput {
  readonly handle: string;
  readonly platform: string;
  readonly direction: ContactDirection;
  readonly campaign_slug: string;
  readonly source?: string;
  readonly email?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** @public */
export interface ContactRef {
  readonly contact_id: string;
  readonly handle: string;
  readonly engagement_score: number;
  readonly campaign_slug: string;
  readonly email?: string;
  readonly status: string;
}

/** @public */
export interface CitadelCampaignPort {
  createCampaign(input: CampaignInput, ctx: ActionContext): Promise<CampaignRef>;
  getCampaign(slug: string, ctx: ActionContext): Promise<CampaignRef | null>;
  updateCampaignStatus(slug: string, status: CampaignStatus, ctx: ActionContext): Promise<void>;

  createAction(input: CampaignActionInput, ctx: ActionContext): Promise<CampaignActionRef>;
  listActions(filter: ActionFilter, ctx: ActionContext): Promise<readonly CampaignActionRef[]>;
  claimAction(action_id: string, ctx: ActionContext): Promise<CampaignActionRef | null>;
  completeAction(completion: ActionCompletion, ctx: ActionContext): Promise<void>;
  blockAction(action_id: string, reason: string, ctx: ActionContext): Promise<void>;
  /**
   * Partial update of an action. ref format: "<campaign_slug>/<action_id>"
   * (same split convention as claimAction/completeAction/blockAction). Maps to
   * MCP update_campaign_action with only the provided patch fields.
   *
   * Added 1.14.0 — promotes the Forge-local shim to a typed port method so
   * Preste and other SDK consumers can update actions without re-implementing
   * the ref-split + tool-call boilerplate.
   */
  updateAction(ref: string, update: CampaignActionPatch, ctx: ActionContext): Promise<void>;

  upsertContact(input: ContactInput, ctx: ActionContext): Promise<ContactRef>;
  findContactByEmail(email: string, ctx: ActionContext): Promise<ContactRef | null>;
  updateContactStatus(contact_id: string, status: string, ctx: ActionContext): Promise<void>;
  bumpEngagementScore(
    contact_id: string,
    delta: number,
    reason: string,
    ctx: ActionContext,
  ): Promise<ContactRef>;
}
