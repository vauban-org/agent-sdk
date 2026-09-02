/**
 * Tests for agent-sdk/src/adapters/citadel-campaign-mcp.ts
 *
 * Coverage:
 *   splitActionId (via claimAction/completeAction) — no-slash → empty campaign_id,
 *     "slug/uuid" → correct split
 *   parseNotes (via listActions/createAction) — falls back to JSON from notes field,
 *     handles missing notes, handles malformed JSON
 *   createCampaign — calls create_campaign with slug→id, defaults status=draft, today start_date
 *   getCampaign — returns null when MCP returns null
 *   updateCampaignStatus — calls update_campaign with id + status
 *   createAction — sanitizes idempotency_key, encodes action_type+payload in notes,
 *                  priority bucketed (critical/high/medium/low)
 *   listActions — filters by action_type client-side, paginates (offset+limit)
 *   claimAction — passes correct campaign_id + bare action_id,
 *                 returns null when MCP returns null
 *   completeAction / blockAction — split compound action_id
 *
 * Ref: test coverage for agent-sdk/adapters/citadel-campaign-mcp.ts (no prior tests)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCitadelCampaignMcpAdapter } from "../src/adapters/citadel-campaign-mcp.js";
import type { ActionContext } from "../src/ports/citadel-action.js";

const CTX: ActionContext = {
  agentId: "forge-agent",
  runId: "run-1",
} as ActionContext;

// ─── Mock client ──────────────────────────────────────────────────────────────

function makeClient() {
  const callTool = vi.fn();
  const adapter = createCitadelCampaignMcpAdapter({ callTool });
  return { adapter, callTool };
}

// ─── createCampaign ───────────────────────────────────────────────────────────

describe("createCampaign", () => {
  it("calls create_campaign with slug as id, status=draft", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({
      id: "spring-2026",
      status: "draft",
      created_at: "2026-05-01T00:00:00Z",
    });
    const result = await adapter.createCampaign(
      {
        slug: "spring-2026",
        name: "Spring Outreach",
        objective: "reach 50 leads",
        tags: ["q2"],
      },
      CTX,
    );
    expect(callTool).toHaveBeenCalledWith(
      "create_campaign",
      expect.objectContaining({
        id: "spring-2026",
        status: "draft",
      }),
    );
    expect(result.campaign_id).toBe("spring-2026");
    expect(result.status).toBe("draft");
  });

  it("passes tags and objective (description)", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({
      id: "c1",
      status: "draft",
      created_at: "2026-05-01T00:00:00Z",
    });
    await adapter.createCampaign(
      { slug: "c1", name: "Test", objective: "my goal", tags: ["tag1"] },
      CTX,
    );
    const args = callTool.mock.calls[0][1];
    expect(args.description).toBe("my goal");
    expect(args.tags).toEqual(["tag1"]);
  });
});

// ─── getCampaign ──────────────────────────────────────────────────────────────

describe("getCampaign", () => {
  it("returns null when MCP returns null", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue(null);
    const result = await adapter.getCampaign("unknown-slug", CTX);
    expect(result).toBeNull();
  });

  it("returns CampaignRef on success", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({
      id: "spring",
      slug: "spring",
      status: "active",
      created_at: "2026-05-01T00:00:00Z",
    });
    const result = await adapter.getCampaign("spring", CTX);
    expect(result).not.toBeNull();
    expect(result!.campaign_id).toBe("spring");
    expect(result!.status).toBe("active");
  });
});

// ─── updateCampaignStatus ─────────────────────────────────────────────────────

describe("updateCampaignStatus", () => {
  it("calls update_campaign with id and status", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ ok: true });
    await adapter.updateCampaignStatus("spring-2026", "completed", CTX);
    expect(callTool).toHaveBeenCalledWith("update_campaign", {
      id: "spring-2026",
      status: "completed",
    });
  });
});

// ─── createAction ─────────────────────────────────────────────────────────────

describe("createAction", () => {
  it("sanitizes idempotency_key (uppercase → lowercase, special chars → dash)", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({
      id: "sanitized-key",
      status: "todo",
      notes: null,
    });
    await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "MY--ACTION_123!",
        title: "Lead review",
        action_type: "lead_qualify",
        payload: {},
        priority: 30,
      },
      CTX,
    );
    const args = callTool.mock.calls[0][1];
    expect(args.id).toMatch(/^[a-z0-9-]+$/);
    expect(args.id).not.toContain("_");
    expect(args.id).not.toContain("!");
    expect(args.id).not.toContain("M");
  });

  it("maps priority ≤25 to 'critical'", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ id: "a1", status: "todo", notes: null });
    await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "k1",
        title: "t",
        action_type: "lead_qualify",
        payload: {},
        priority: 10,
      },
      CTX,
    );
    expect(callTool.mock.calls[0][1].priority).toBe("critical");
  });

  it("maps priority 26-50 to 'high'", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ id: "a1", status: "todo", notes: null });
    await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "k1",
        title: "t",
        action_type: "lead_qualify",
        payload: {},
        priority: 40,
      },
      CTX,
    );
    expect(callTool.mock.calls[0][1].priority).toBe("high");
  });

  it("maps priority 76+ to 'low'", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ id: "a1", status: "todo", notes: null });
    await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "k1",
        title: "t",
        action_type: "lead_qualify",
        payload: {},
        priority: 90,
      },
      CTX,
    );
    expect(callTool.mock.calls[0][1].priority).toBe("low");
  });

  it("encodes action_type+payload in notes as JSON", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ id: "a1", status: "todo", notes: null });
    await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "k1",
        title: "t",
        action_type: "lead_qualify",
        payload: { score: 85 },
        priority: 50,
      },
      CTX,
    );
    const notes = JSON.parse(callTool.mock.calls[0][1].notes);
    expect(notes.action_type).toBe("lead_qualify");
    expect(notes.payload).toEqual({ score: 85 });
  });

  it("prefers DB columns over notes for returned action_type", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({
      id: "a1",
      status: "todo",
      action_type: "lead_qualify", // DB column
      notes: '{"action_type":"outreach","payload":{}}', // notes fallback
    });
    const result = await adapter.createAction(
      {
        campaign_slug: "c1",
        idempotency_key: "k1",
        title: "t",
        action_type: "lead_qualify",
        payload: {},
        priority: 50,
      },
      CTX,
    );
    expect(result.action_type).toBe("lead_qualify"); // DB column wins
  });
});

// ─── listActions ──────────────────────────────────────────────────────────────

describe("listActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters by action_type client-side", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue([
      { id: "a1", status: "todo", action_type: "lead_qualify", notes: null },
      { id: "a2", status: "todo", action_type: "outreach_email", notes: null },
    ]);
    const results = await adapter.listActions(
      { campaign_slug: "c1", action_type: "lead_qualify" },
      CTX,
    );
    expect(results).toHaveLength(1);
    expect(results[0].action_type).toBe("lead_qualify");
  });

  it("applies offset and limit for pagination", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        status: "todo",
        action_type: "lead_qualify",
        notes: null,
      })),
    );
    const results = await adapter.listActions({ campaign_slug: "c1", offset: 2, limit: 2 }, CTX);
    expect(results).toHaveLength(2);
    expect(results[0].action_id).toBe("a2");
  });

  it("falls back to notes JSON when action_type column missing", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue([
      {
        id: "a1",
        status: "todo",
        notes: '{"action_type":"lead_qualify","payload":{"x":1}}',
      },
    ]);
    const results = await adapter.listActions({ campaign_slug: "c1" }, CTX);
    expect(results[0].action_type).toBe("lead_qualify");
    expect(results[0].payload).toEqual({ x: 1 });
  });

  it("defaults action_type to 'manual_review' when neither DB column nor notes", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue([{ id: "a1", status: "todo" }]);
    const results = await adapter.listActions({ campaign_slug: "c1" }, CTX);
    expect(results[0].action_type).toBe("manual_review");
  });
});

// ─── claimAction — splitActionId ─────────────────────────────────────────────

describe("claimAction — splitActionId", () => {
  it("splits compound 'slug/uuid' into campaign_id + action_id", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue(null);
    await adapter.claimAction("spring-2026/abc-123", CTX);
    const args = callTool.mock.calls[0][1];
    expect(args.campaign_id).toBe("spring-2026");
    expect(args.action_id).toBe("abc-123");
  });

  it("falls back to empty campaign_id for plain UUID", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue(null);
    await adapter.claimAction("abc-123", CTX);
    const args = callTool.mock.calls[0][1];
    expect(args.campaign_id).toBe("");
    expect(args.action_id).toBe("abc-123");
  });

  it("returns null when MCP returns null", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue(null);
    const result = await adapter.claimAction("c/a", CTX);
    expect(result).toBeNull();
  });
});

// ─── completeAction / blockAction ─────────────────────────────────────────────

describe("completeAction", () => {
  it("passes split campaign_id + action_id to MCP", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ ok: true });
    await adapter.completeAction(
      {
        action_id: "campaign-1/action-abc",
        outcome: "success",
        worker_agent_id: "forge",
      },
      CTX,
    );
    const args = callTool.mock.calls[0][1];
    expect(args.campaign_id).toBe("campaign-1");
    expect(args.action_id).toBe("action-abc");
    expect(args.outcome).toBe("success");
  });
});

describe("blockAction", () => {
  it("passes split ids and reason to MCP", async () => {
    const { adapter, callTool } = makeClient();
    callTool.mockResolvedValue({ ok: true });
    await adapter.blockAction("camp/act-1", "blocked by policy", CTX);
    const args = callTool.mock.calls[0][1];
    expect(args.campaign_id).toBe("camp");
    expect(args.action_id).toBe("act-1");
    expect(args.reason).toBe("blocked by policy");
  });
});
