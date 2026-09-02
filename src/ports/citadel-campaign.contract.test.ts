import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ActionContext } from "./citadel-action.js";
import type {
  CampaignActionInput,
  CampaignActionRef,
  CampaignActionStatus,
  CampaignInput,
  CampaignRef,
  CampaignStatus,
  CitadelCampaignPort,
  ContactInput,
  ContactRef,
} from "./citadel-campaign.js";

// In-memory reference implementation. Defines the contract.
// Real adapters (citadel-campaign-mcp) must pass the same tests.
class InMemoryCitadelCampaignPort implements CitadelCampaignPort {
  campaigns = new Map<string, CampaignRef>();
  actions = new Map<string, CampaignActionRef & { idempotency_key: string }>();
  contacts = new Map<string, ContactRef>();
  emailToContactId = new Map<string, string>();

  async createCampaign(input: CampaignInput, _ctx: ActionContext): Promise<CampaignRef> {
    if (this.campaigns.has(input.slug)) {
      throw new Error(`campaign already exists: ${input.slug}`);
    }
    const ref: CampaignRef = {
      campaign_id: randomUUID(),
      slug: input.slug,
      status: "draft",
      created_at: new Date(),
    };
    this.campaigns.set(input.slug, ref);
    return ref;
  }

  async getCampaign(slug: string, _ctx: ActionContext): Promise<CampaignRef | null> {
    return this.campaigns.get(slug) ?? null;
  }

  async updateCampaignStatus(
    slug: string,
    status: CampaignStatus,
    _ctx: ActionContext,
  ): Promise<void> {
    const c = this.campaigns.get(slug);
    if (!c) throw new Error(`campaign not found: ${slug}`);
    this.campaigns.set(slug, { ...c, status });
  }

  async createAction(input: CampaignActionInput, _ctx: ActionContext): Promise<CampaignActionRef> {
    // Idempotency check
    for (const a of this.actions.values()) {
      if (a.campaign_slug === input.campaign_slug && a.idempotency_key === input.idempotency_key) {
        return a;
      }
    }
    const ref: CampaignActionRef & { idempotency_key: string } = {
      action_id: randomUUID(),
      campaign_slug: input.campaign_slug,
      action_type: input.action_type,
      status: "todo",
      priority: input.priority ?? 50,
      payload: input.payload,
      contact_id: input.contact_id,
      idempotency_key: input.idempotency_key,
    };
    this.actions.set(ref.action_id, ref);
    return ref;
  }

  async listActions(
    filter: {
      campaign_slug?: string;
      status?: CampaignActionStatus;
      action_type?: string;
      limit?: number;
      offset?: number;
    },
    _ctx: ActionContext,
  ): Promise<readonly CampaignActionRef[]> {
    let out = [...this.actions.values()];
    if (filter.campaign_slug) out = out.filter((a) => a.campaign_slug === filter.campaign_slug);
    if (filter.status) out = out.filter((a) => a.status === filter.status);
    if (filter.action_type) out = out.filter((a) => a.action_type === filter.action_type);
    out.sort((a, b) => a.priority - b.priority);
    const start = filter.offset ?? 0;
    const end = start + (filter.limit ?? 100);
    return out.slice(start, end);
  }

  async claimAction(action_id: string, _ctx: ActionContext): Promise<CampaignActionRef | null> {
    const a = this.actions.get(action_id);
    if (!a || a.status !== "todo") return null;
    const claimed = { ...a, status: "in_progress" as const };
    this.actions.set(action_id, claimed);
    return claimed;
  }

  async completeAction(
    c: { action_id: string; outcome: "success" | "failure" | "skipped" },
    _ctx: ActionContext,
  ): Promise<void> {
    const a = this.actions.get(c.action_id);
    if (!a) throw new Error(`action not found: ${c.action_id}`);
    const newStatus: CampaignActionStatus =
      c.outcome === "success" ? "done" : c.outcome === "skipped" ? "skipped" : "blocked";
    this.actions.set(c.action_id, { ...a, status: newStatus });
  }

  async blockAction(action_id: string, _reason: string, _ctx: ActionContext): Promise<void> {
    const a = this.actions.get(action_id);
    if (!a) throw new Error(`action not found: ${action_id}`);
    this.actions.set(action_id, { ...a, status: "blocked" });
  }

  async updateAction(
    ref: string,
    update: {
      payload?: Readonly<Record<string, unknown>>;
      status?: CampaignActionStatus;
      notes?: string;
      publish_evidence?: Readonly<Record<string, unknown>>;
      scheduled_at?: string;
      phase?: string;
    },
    _ctx: ActionContext,
  ): Promise<void> {
    // Support both bare action_id and compound "<campaign_slug>/<action_id>" refs.
    const slash = ref.indexOf("/");
    const action_id = slash === -1 ? ref : ref.slice(slash + 1);
    const a = this.actions.get(action_id);
    if (!a) throw new Error(`action not found: ${ref}`);
    const next: CampaignActionRef & { idempotency_key: string } = {
      ...a,
      ...(update.payload !== undefined ? { payload: update.payload } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
    };
    this.actions.set(action_id, next);
  }

  async upsertContact(input: ContactInput, _ctx: ActionContext): Promise<ContactRef> {
    const key = `${input.platform}:${input.handle}:${input.campaign_slug}`;
    const existing = [...this.contacts.values()].find(
      (c) => `${input.platform}:${c.handle}:${c.campaign_slug}` === key,
    );
    if (existing) return existing;
    const ref: ContactRef = {
      contact_id: randomUUID(),
      handle: input.handle,
      engagement_score: 0,
      campaign_slug: input.campaign_slug,
      email: input.email,
      status: "identified",
    };
    this.contacts.set(ref.contact_id, ref);
    if (ref.email) this.emailToContactId.set(ref.email, ref.contact_id);
    return ref;
  }

  async findContactByEmail(email: string, _ctx: ActionContext): Promise<ContactRef | null> {
    const id = this.emailToContactId.get(email);
    if (!id) return null;
    return this.contacts.get(id) ?? null;
  }

  async updateContactStatus(
    contact_id: string,
    status: string,
    _ctx: ActionContext,
  ): Promise<void> {
    const c = this.contacts.get(contact_id);
    if (!c) throw new Error(`contact not found: ${contact_id}`);
    this.contacts.set(contact_id, { ...c, status });
  }

  async bumpEngagementScore(
    contact_id: string,
    delta: number,
    _reason: string,
    _ctx: ActionContext,
  ): Promise<ContactRef> {
    const c = this.contacts.get(contact_id);
    if (!c) throw new Error(`contact not found: ${contact_id}`);
    const updated = { ...c, engagement_score: c.engagement_score + delta };
    this.contacts.set(contact_id, updated);
    return updated;
  }
}

const ctx: ActionContext = {
  agentId: "test-agent",
  agentTier: "T2",
  runId: "test-run",
};

describe("CitadelCampaignPort contract", () => {
  it("createCampaign returns a draft CampaignRef", async () => {
    const port = new InMemoryCitadelCampaignPort();
    const ref = await port.createCampaign(
      { slug: "test-camp", name: "Test", product: "test", objective: "verify contract" },
      ctx,
    );
    expect(ref.slug).toBe("test-camp");
    expect(ref.status).toBe("draft");
  });

  it("createAction is idempotent by (campaign_slug, idempotency_key)", async () => {
    const port = new InMemoryCitadelCampaignPort();
    await port.createCampaign({ slug: "c1", name: "C1", product: "p", objective: "o" }, ctx);
    const a1 = await port.createAction(
      {
        campaign_slug: "c1",
        action_type: "publish_article",
        title: "Art 1",
        payload: { x: 1 },
        idempotency_key: "art-1",
      },
      ctx,
    );
    const a2 = await port.createAction(
      {
        campaign_slug: "c1",
        action_type: "publish_article",
        title: "Art 1 retry",
        payload: { x: 1 },
        idempotency_key: "art-1",
      },
      ctx,
    );
    expect(a2.action_id).toBe(a1.action_id);
  });

  it("claimAction returns null on second call (race lost)", async () => {
    const port = new InMemoryCitadelCampaignPort();
    await port.createCampaign({ slug: "c2", name: "C2", product: "p", objective: "o" }, ctx);
    const a = await port.createAction(
      {
        campaign_slug: "c2",
        action_type: "publish_article",
        title: "X",
        payload: {},
        idempotency_key: "x",
      },
      ctx,
    );
    const r1 = await port.claimAction(a.action_id, ctx);
    const r2 = await port.claimAction(a.action_id, ctx);
    expect(r1?.status).toBe("in_progress");
    expect(r2).toBeNull();
  });

  it("listActions filters by status and sorts by priority asc", async () => {
    const port = new InMemoryCitadelCampaignPort();
    await port.createCampaign({ slug: "c3", name: "C3", product: "p", objective: "o" }, ctx);
    await port.createAction(
      {
        campaign_slug: "c3",
        action_type: "publish_article",
        title: "A",
        payload: {},
        idempotency_key: "a",
        priority: 10,
      },
      ctx,
    );
    await port.createAction(
      {
        campaign_slug: "c3",
        action_type: "publish_article",
        title: "B",
        payload: {},
        idempotency_key: "b",
        priority: 1,
      },
      ctx,
    );
    const todos = await port.listActions({ status: "todo" }, ctx);
    expect(todos[0]?.priority).toBe(1);
    expect(todos[1]?.priority).toBe(10);
  });

  it("bumpEngagementScore is additive", async () => {
    const port = new InMemoryCitadelCampaignPort();
    await port.createCampaign({ slug: "c4", name: "C4", product: "p", objective: "o" }, ctx);
    const contact = await port.upsertContact(
      { handle: "@alice", platform: "x", direction: "outbound", campaign_slug: "c4" },
      ctx,
    );
    await port.bumpEngagementScore(contact.contact_id, 0.3, "reply", ctx);
    await port.bumpEngagementScore(contact.contact_id, 0.2, "follow", ctx);
    const final = await port.bumpEngagementScore(contact.contact_id, -0.1, "noise", ctx);
    expect(final.engagement_score).toBeCloseTo(0.4);
  });
});
