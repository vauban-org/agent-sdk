import { describe, expect, it } from "vitest";
import type { ActionContext } from "../ports/citadel-action.js";
import { createCitadelCampaignMcpAdapter } from "./citadel-campaign-mcp.js";

const ctx: ActionContext = { agentId: "test", agentTier: "T2", runId: "r1" };

function fakeClient(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const handler = handlers[name];
      if (!handler) throw new Error(`unmocked tool: ${name}`);
      return handler(args);
    },
  };
}

describe("citadel-campaign-mcp adapter", () => {
  it("createCampaign maps MCP response to CampaignRef", async () => {
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        create_campaign: () => ({
          id: "11111111-1111-1111-1111-111111111111",
          slug: "test",
          status: "draft",
          created_at: "2026-05-18T10:00:00Z",
        }),
      }),
    );
    const ref = await adapter.createCampaign(
      { slug: "test", name: "Test", product: "p", objective: "o" },
      ctx,
    );
    expect(ref.campaign_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(ref.status).toBe("draft");
    expect(ref.created_at).toBeInstanceOf(Date);
  });

  it("claimAction returns null when MCP returns null (race lost)", async () => {
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        claim_campaign_action: () => null,
      }),
    );
    const result = await adapter.claimAction("00000000-0000-0000-0000-000000000000", ctx);
    expect(result).toBeNull();
  });

  it("claimAction passes agentId + runId from ctx to MCP", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        claim_campaign_action: (args) => {
          captured = args;
          return {
            id: "a",
            campaign_slug: "c",
            action_type: "publish_article",
            status: "in_progress",
            priority: 1,
            payload: {},
          };
        },
      }),
    );
    await adapter.claimAction("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ctx);
    expect(captured.agent_id).toBe("test");
    expect(captured.run_id).toBe("r1");
  });

  it("getCampaign returns null when MCP returns null (campaign not found)", async () => {
    const adapter = createCitadelCampaignMcpAdapter(fakeClient({ get_campaign: () => null }));
    const result = await adapter.getCampaign("no-such-campaign", ctx);
    expect(result).toBeNull();
  });

  it("getCampaign maps MCP row to CampaignRef with correct fields", async () => {
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        get_campaign: () => ({
          id: "22222222-2222-2222-2222-222222222222",
          slug: "my-campaign",
          status: "active",
          created_at: "2026-01-01T00:00:00Z",
        }),
      }),
    );
    const ref = await adapter.getCampaign("my-campaign", ctx);
    expect(ref).not.toBeNull();
    expect(ref!.campaign_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(ref!.status).toBe("active");
    expect(ref!.created_at).toBeInstanceOf(Date);
  });

  it("claimAction splits compound action_id and passes campaign_id + bare action_id", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        claim_campaign_action: (args) => {
          captured = args;
          return {
            action: {
              id: "bare-action-uuid",
              campaign_id: "my-campaign",
              status: "in_progress",
              action_type: "publish_article",
              payload: {},
            },
          };
        },
      }),
    );
    await adapter.claimAction("my-campaign/bare-action-uuid", ctx);
    expect(captured.campaign_id).toBe("my-campaign");
    expect(captured.action_id).toBe("bare-action-uuid");
  });

  it("listActions filters by action_type client-side", async () => {
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        get_campaign_actions: () => [
          { id: "a1", action_type: "publish_article", status: "todo" },
          { id: "a2", action_type: "send_dm", status: "todo" },
          { id: "a3", action_type: "publish_article", status: "done" },
        ],
      }),
    );
    const results = await adapter.listActions(
      { campaign_slug: "my-campaign", action_type: "publish_article" },
      ctx,
    );
    expect(results).toHaveLength(2);
    expect(results.every((a) => a.action_type === "publish_article")).toBe(true);
  });

  it("listActions forwards scheduled_before (Date) as RFC3339 to MCP tool args", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        get_campaign_actions: (args) => {
          captured = args;
          return [];
        },
      }),
    );
    const cutoff = new Date("2026-05-21T12:00:00Z");
    await adapter.listActions({ campaign_slug: "my-campaign", scheduled_before: cutoff }, ctx);
    expect(captured.campaign_id).toBe("my-campaign");
    expect(captured.scheduled_before).toBe("2026-05-21T12:00:00.000Z");
  });

  it("listActions forwards scheduled_before (string) as-is", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        get_campaign_actions: (args) => {
          captured = args;
          return [];
        },
      }),
    );
    await adapter.listActions(
      { campaign_slug: "c1", scheduled_before: "2026-05-21T12:00:00Z" },
      ctx,
    );
    expect(captured.scheduled_before).toBe("2026-05-21T12:00:00Z");
  });

  it("listActions omits scheduled_before arg when filter is absent (backwards-compat)", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        get_campaign_actions: (args) => {
          captured = args;
          return [];
        },
      }),
    );
    await adapter.listActions({ campaign_slug: "c1", status: "todo" }, ctx);
    expect(captured).not.toHaveProperty("scheduled_before");
    expect(captured.status).toBe("todo");
  });

  it("updateAction forwards patch fields to update_campaign_action MCP tool", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        update_campaign_action: (args) => {
          captured = args;
          return { ok: true };
        },
      }),
    );
    await adapter.updateAction(
      "my-campaign/action-uuid-1",
      {
        status: "done",
        publish_evidence: { url: "https://x.com/post/123", platform: "x" },
        notes: "shipped 2026-05-21",
      },
      ctx,
    );
    expect(captured.campaign_id).toBe("my-campaign");
    expect(captured.action_id).toBe("action-uuid-1");
    expect(captured.status).toBe("done");
    expect(captured.publish_evidence).toEqual({
      url: "https://x.com/post/123",
      platform: "x",
    });
    expect(captured.notes).toBe("shipped 2026-05-21");
    expect(captured).not.toHaveProperty("payload");
    expect(captured).not.toHaveProperty("phase");
  });

  it("updateAction omits undefined patch fields (partial update)", async () => {
    let captured: Record<string, unknown> = {};
    const adapter = createCitadelCampaignMcpAdapter(
      fakeClient({
        update_campaign_action: (args) => {
          captured = args;
          return { ok: true };
        },
      }),
    );
    await adapter.updateAction("c1/a1", { phase: "outreach" }, ctx);
    expect(captured.phase).toBe("outreach");
    expect(Object.keys(captured).sort()).toEqual(["action_id", "campaign_id", "phase"].sort());
  });
});
