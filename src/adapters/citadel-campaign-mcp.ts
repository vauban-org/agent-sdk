/**
 * MCP-backed implementation of CitadelCampaignPort.
 *
 * Routes every method to the corresponding Citadel MCP tool.
 * Caller injects an MCP client (OAuth or M2M auth handled upstream).
 *
 * Schema adaptation notes (mismatches between port contract and Citadel MCP tools):
 *
 * - create_campaign: MCP requires `id` (slug), `status`, and `start_date`.
 *   We default status to "draft" and start_date to today's ISO date.
 * - get_campaign: MCP uses `get_campaign({ id })`, not `get_campaigns({ slug })`.
 * - update_campaign: MCP uses `id` field, not `slug`.
 * - create_campaign_action: MCP uses `campaign_id` + `id` (idempotency key) + `name`.
 *   No `action_type` or `payload` fields — stored in `notes` as JSON for round-trip.
 * - get_campaign_actions: MCP uses `campaign_id`, no `action_type`/`limit`/`offset`.
 *   Action-type and pagination filters applied client-side.
 * - claim_campaign_action / complete_campaign_action / block_campaign_action:
 *   MCP requires `campaign_id` which is NOT part of the port signature.
 *   Callers must embed campaign_id in action_id as "<campaign_id>/<uuid>" for production use.
 *   The adapter splits on "/" — if no slash is present, campaign_id defaults to "".
 * - upsertContact: no direct MCP equivalent; mapped to record_inbound_signal.
 * - updateContactStatus: mapped to promote_contact (pipeline status transition).
 * - bumpEngagementScore: MCP returns { ok, contact } — contact shape cast to ContactRef.
 */

import type { ActionContext } from "../ports/citadel-action.js";
import type {
  ActionCompletion,
  ActionFilter,
  CampaignActionInput,
  CampaignActionPatch,
  CampaignActionRef,
  CampaignInput,
  CampaignRef,
  CampaignStatus,
  CitadelCampaignPort,
  ContactInput,
  ContactRef,
} from "../ports/citadel-campaign.js";

/** @public */
export interface CitadelCampaignMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Split a possibly-compound action id into [campaign_id, action_id].
 * Production callers encode as "<campaign_slug>/<uuid>".
 * Plain UUID format falls back to campaign_id = "".
 */
function splitActionId(compoundId: string): { campaign_id: string; action_id: string } {
  const slash = compoundId.indexOf("/");
  if (slash === -1) return { campaign_id: "", action_id: compoundId };
  return {
    campaign_id: compoundId.slice(0, slash),
    action_id: compoundId.slice(slash + 1),
  };
}

/**
 * Parse action metadata stored in the `notes` field (JSON-encoded).
 */
function parseNotes(notes: string | undefined): {
  action_type?: string;
  payload?: Record<string, unknown>;
} {
  if (!notes) return {};
  try {
    return JSON.parse(notes) as { action_type?: string; payload?: Record<string, unknown> };
  } catch {
    return {};
  }
}

/** @public */
export function createCitadelCampaignMcpAdapter(
  client: CitadelCampaignMcpClient,
): CitadelCampaignPort {
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool(name, args);
    return result as T;
  };

  return {
    async createCampaign(input: CampaignInput, _ctx: ActionContext): Promise<CampaignRef> {
      const today = new Date().toISOString().slice(0, 10);
      const row = await call<{
        id: string;
        slug?: string;
        status: CampaignStatus;
        created_at: string;
      }>("create_campaign", {
        id: input.slug,
        name: input.name,
        status: "draft",
        start_date: today,
        description: input.objective,
        tags: input.tags ?? [],
      });
      return {
        campaign_id: row.id,
        slug: row.slug ?? input.slug,
        status: row.status,
        created_at: new Date(row.created_at),
      };
    },

    async getCampaign(slug: string, _ctx: ActionContext): Promise<CampaignRef | null> {
      const row = await call<{
        id: string;
        slug?: string;
        status: CampaignStatus;
        created_at: string;
      } | null>("get_campaign", { id: slug });
      if (!row) return null;
      return {
        campaign_id: row.id,
        slug: row.slug ?? slug,
        status: row.status,
        created_at: new Date(row.created_at),
      };
    },

    async updateCampaignStatus(
      slug: string,
      status: CampaignStatus,
      _ctx: ActionContext,
    ): Promise<void> {
      await call("update_campaign", { id: slug, status });
    },

    async createAction(
      input: CampaignActionInput,
      _ctx: ActionContext,
    ): Promise<CampaignActionRef> {
      // Since Citadel v0.10 (dashboard route patch sprint-718), action_type, payload
      // and idempotency_key are extracted from the body and persisted directly.
      // Keep notes JSON as belt-and-suspenders fallback for older Citadel versions.
      const notes = JSON.stringify({ action_type: input.action_type, payload: input.payload });
      // Citadel validates id as ^[a-z0-9-]+$ (max 99 chars). The SDK accepts
      // any string as idempotency_key; sanitize here to fit the constraint.
      const safeId = input.idempotency_key
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 99);
      const row = await call<{
        id: string;
        campaign_id?: string;
        campaign_slug?: string;
        action_id?: string;
        name?: string;
        status?: string;
        priority?: string;
        notes?: string;
        action_type?: string;
        payload?: Record<string, unknown> | null;
        idempotency_key?: string | null;
      }>("create_campaign_action", {
        campaign_id: input.campaign_slug,
        id: safeId,
        name: input.title,
        priority:
          input.priority != null && input.priority <= 25
            ? "critical"
            : input.priority != null && input.priority <= 50
              ? "high"
              : input.priority != null && input.priority <= 75
                ? "medium"
                : "low",
        due_date: input.due_date,
        notes,
        action_type: input.action_type,
        payload: input.payload,
        idempotency_key: safeId,
      });
      // Prefer DB column (ground truth post-sprint-718); fall back to notes JSON
      // for Citadel deployments that have not yet applied the route patch.
      const parsed = parseNotes(row.notes);
      return {
        action_id: row.id ?? input.idempotency_key,
        campaign_slug: row.campaign_id ?? row.campaign_slug ?? input.campaign_slug,
        action_type: (row.action_type ??
          parsed.action_type ??
          input.action_type) as CampaignActionRef["action_type"],
        status: (row.status ?? "todo") as CampaignActionRef["status"],
        priority: input.priority ?? 50,
        payload: (row.payload ?? parsed.payload ?? input.payload) as CampaignActionRef["payload"],
        contact_id: input.contact_id,
      };
    },

    async listActions(
      filter: ActionFilter,
      _ctx: ActionContext,
    ): Promise<readonly CampaignActionRef[]> {
      type Row = {
        id: string;
        name?: string;
        campaign_id?: string;
        campaign_slug?: string;
        status?: string;
        priority?: string;
        notes?: string;
        action_type?: string;
        payload?: Record<string, unknown> | null;
        idempotency_key?: string | null;
      };
      // Citadel's get_campaign_actions REQUIRES campaign_id and does NOT return
      // it in the response rows. The SDK must track which campaign each row
      // came from to populate campaign_slug. Tuple = (queriedCampaignSlug, rows).
      //
      // scheduled_before (added 1.14.0) is server-side filtered by Citadel
      // since commit 44391dc. We forward it as RFC3339 string. Backwards-compat:
      // SDK 1.13 callers that omit it pass through unchanged.
      const scheduledBeforeArg =
        filter.scheduled_before instanceof Date
          ? filter.scheduled_before.toISOString()
          : filter.scheduled_before;
      const baseArgs = (campaignId: string): Record<string, unknown> => {
        const args: Record<string, unknown> = { campaign_id: campaignId };
        if (filter.status !== undefined) args.status = filter.status;
        if (scheduledBeforeArg !== undefined) args.scheduled_before = scheduledBeforeArg;
        return args;
      };
      let perCampaign: Array<{ campaignSlug: string; rows: Row[] }>;
      if (filter.campaign_slug) {
        const rows =
          (await call<Row[]>("get_campaign_actions", baseArgs(filter.campaign_slug))) ?? [];
        perCampaign = [{ campaignSlug: filter.campaign_slug, rows }];
      } else {
        const campaigns =
          (await call<Array<{ id: string; slug?: string }>>("get_campaigns", {
            status: "active",
          })) ?? [];
        perCampaign = await Promise.all(
          campaigns.map(async (c) => {
            const slug = c.slug ?? c.id;
            const rows = (await call<Row[]>("get_campaign_actions", baseArgs(c.id))) ?? [];
            return { campaignSlug: slug, rows };
          }),
        );
      }
      let out: CampaignActionRef[] = [];
      for (const { campaignSlug, rows } of perCampaign) {
        for (const row of rows) {
          // Prefer DB column (ground truth post-sprint-718 migration);
          // fall back to notes JSON for rows written before the patch.
          const parsed = parseNotes(row.notes);
          out.push({
            action_id: row.id,
            name: row.name,
            campaign_slug: row.campaign_id ?? row.campaign_slug ?? campaignSlug,
            action_type: (row.action_type ??
              parsed.action_type ??
              "manual_review") as CampaignActionRef["action_type"],
            status: (row.status ?? "todo") as CampaignActionRef["status"],
            priority: 50,
            payload: (row.payload ?? parsed.payload ?? {}) as CampaignActionRef["payload"],
          });
        }
      }
      if (filter.action_type) {
        out = out.filter((a) => a.action_type === filter.action_type);
      }
      const start = filter.offset ?? 0;
      const end = start + (filter.limit ?? 100);
      return out.slice(start, end);
    },

    async claimAction(action_id: string, ctx: ActionContext): Promise<CampaignActionRef | null> {
      const { campaign_id, action_id: bare_id } = splitActionId(action_id);
      const row = await call<{
        id?: string;
        action?: {
          id: string;
          campaign_id?: string;
          campaign_slug?: string;
          status?: string;
          notes?: string;
        };
        ok?: boolean;
      } | null>("claim_campaign_action", {
        campaign_id,
        action_id: bare_id,
        agent_id: ctx.agentId,
        run_id: ctx.runId,
      });
      if (!row) return null;
      // MCP returns { ok, action } shape from citadel-client
      const action =
        (
          row as {
            action?: {
              id: string;
              campaign_id?: string;
              status?: string;
              notes?: string;
              action_type?: string;
              payload?: Record<string, unknown> | null;
            };
            id?: string;
            status?: string;
            notes?: string;
            action_type?: string;
            payload?: Record<string, unknown> | null;
          }
        ).action ?? row;
      if (
        !action ||
        typeof action !== "object" ||
        !("id" in action) ||
        !(action as { id?: unknown }).id
      )
        return null;
      const a = action as {
        id: string;
        campaign_id?: string;
        campaign_slug?: string;
        status?: string;
        notes?: string;
        action_type?: string;
        payload?: Record<string, unknown> | null;
      };
      // Prefer DB column (ground truth post-sprint-718); fall back to notes JSON.
      const parsed = parseNotes(a.notes);
      return {
        action_id: a.id,
        campaign_slug: a.campaign_id ?? a.campaign_slug ?? campaign_id,
        action_type: (a.action_type ??
          parsed.action_type ??
          "manual_review") as CampaignActionRef["action_type"],
        status: (a.status ?? "in_progress") as CampaignActionRef["status"],
        priority: 50,
        payload: (a.payload ?? parsed.payload ?? {}) as CampaignActionRef["payload"],
      };
    },

    async completeAction(c: ActionCompletion, _ctx: ActionContext): Promise<void> {
      const { campaign_id, action_id } = splitActionId(c.action_id);
      await call("complete_campaign_action", {
        campaign_id,
        action_id,
        outcome: c.outcome,
        evidence: c.evidence,
        error: c.error,
        worker_agent_id: c.worker_agent_id,
      });
    },

    async blockAction(action_id: string, reason: string, _ctx: ActionContext): Promise<void> {
      const { campaign_id, action_id: bare_id } = splitActionId(action_id);
      await call("block_campaign_action", { campaign_id, action_id: bare_id, reason });
    },

    async updateAction(
      ref: string,
      update: CampaignActionPatch,
      _ctx: ActionContext,
    ): Promise<void> {
      const { campaign_id, action_id } = splitActionId(ref);
      const args: Record<string, unknown> = { campaign_id, action_id };
      if (update.payload !== undefined) args.payload = update.payload;
      if (update.status !== undefined) args.status = update.status;
      if (update.notes !== undefined) args.notes = update.notes;
      if (update.publish_evidence !== undefined) args.publish_evidence = update.publish_evidence;
      if (update.scheduled_at !== undefined) args.scheduled_at = update.scheduled_at;
      if (update.phase !== undefined) args.phase = update.phase;
      await call("update_campaign_action", args);
    },

    async upsertContact(input: ContactInput, ctx: ActionContext): Promise<ContactRef> {
      // No direct upsert tool in Citadel MCP. Use record_inbound_signal which
      // creates-or-finds a contact and returns { action_id, contact_id, contact_created }.
      const result = await call<{
        action_id: string;
        contact_id: string;
        contact_created: boolean;
      }>("record_inbound_signal", {
        contact_handle: input.handle,
        campaign_id: input.campaign_slug,
        platform: input.platform,
        signal_type: input.direction === "inbound" ? "engagement_reply" : "publish",
        agent_id: ctx.agentId,
        run_id: ctx.runId,
      });
      return {
        contact_id: result.contact_id,
        handle: input.handle,
        engagement_score: 0,
        campaign_slug: input.campaign_slug,
        email: input.email,
        status: "identified",
      };
    },

    async findContactByEmail(email: string, _ctx: ActionContext): Promise<ContactRef | null> {
      // MCP returns { contact: Row | null } shape.
      const result = await call<unknown>("find_contact_by_email", { email });
      if (!result) return null;
      // Unwrap { contact } envelope if present, otherwise treat result itself as the row.
      const envelope = result as Record<string, unknown>;
      const raw = envelope.contact !== undefined ? envelope.contact : result;
      if (!raw || typeof raw !== "object" || !("id" in raw) || !(raw as { id?: unknown }).id)
        return null;
      const r = raw as {
        id: string;
        name?: string;
        handle?: string;
        engagement_score?: number;
        campaign_id?: string;
        campaign_slug?: string;
        email?: string;
        status?: string;
      };
      return {
        contact_id: r.id,
        handle: r.name ?? r.handle ?? email,
        engagement_score: r.engagement_score ?? 0,
        campaign_slug: r.campaign_id ?? r.campaign_slug ?? "",
        email: r.email ?? email,
        status: r.status ?? "identified",
      };
    },

    async updateContactStatus(
      contact_id: string,
      status: string,
      _ctx: ActionContext,
    ): Promise<void> {
      // promote_contact handles pipeline status transitions.
      await call("promote_contact", {
        contact_id,
        to_status: status,
        rationale: "status update via CitadelCampaignPort",
      });
    },

    async bumpEngagementScore(
      contact_id: string,
      delta: number,
      reason: string,
      _ctx: ActionContext,
    ): Promise<ContactRef> {
      const result = await call<{
        ok: boolean;
        contact: {
          id: string;
          name?: string;
          handle?: string;
          engagement_score: number;
          campaign_id?: string;
          campaign_slug?: string;
          email?: string;
          status?: string;
        };
      }>("bump_engagement_score", { contact_id, delta, reason });
      const r = result.contact;
      return {
        contact_id: r.id,
        handle: r.name ?? r.handle ?? contact_id,
        engagement_score: r.engagement_score,
        campaign_slug: r.campaign_id ?? r.campaign_slug ?? "",
        email: r.email,
        status: r.status ?? "identified",
      };
    },
  };
}
