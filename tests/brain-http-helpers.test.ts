/**
 * Tests for createHttpBrainAdapter — archivePostmortem + archiveLesson helpers.
 *
 * Verifies that the two reserved-category helpers delegate to archiveKnowledge
 * with the correct category and tag conventions (Phase 9 campaign orchestrator).
 *
 * Ref: feat(brain): SDK helpers archivePostmortem + archiveLesson
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpBrainAdapter } from "../src/adapters/brain-http.js";
import type { LessonInput, PostmortemInput } from "../src/ports/brain.js";

// ─── Mock global.fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as Response;
}

const BASE_ENTRY = {
  id: "entry-001",
  content: "test",
  category: "vauban_postmortem",
  tags: [],
  created_at: "2026-05-18T10:00:00Z",
};

function makeAdapter() {
  return createHttpBrainAdapter({
    baseUrl: "https://brain.api.vauban.tech",
    brainId: "brain-test-uuid",
    apiKey: "test-api-key",
  });
}

// ─── archivePostmortem ────────────────────────────────────────────────────────

describe("archivePostmortem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse(BASE_ENTRY));
  });

  const postmortem: PostmortemInput = {
    campaign_slug: "outbound-q2-2026",
    outcome: "partial",
    metrics: { replies: 12, demos: 2 },
    what_worked: ["personalized subject lines"],
    what_failed: ["follow-up cadence too aggressive"],
    lessons: ["Test subject line variants first"],
  };

  it("calls archiveKnowledge with category vauban_postmortem", async () => {
    const adapter = makeAdapter();
    await adapter.archivePostmortem!(postmortem);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.category).toBe("vauban_postmortem");
  });

  it("includes campaign slug and outcome in tags", async () => {
    const adapter = makeAdapter();
    await adapter.archivePostmortem!(postmortem);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tags).toContain("postmortem");
    expect(body.tags).toContain("campaign:outbound-q2-2026");
    expect(body.tags).toContain("outcome:partial");
  });

  it("serializes the full PostmortemInput as content JSON", async () => {
    const adapter = makeAdapter();
    await adapter.archivePostmortem!(postmortem);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const parsed = JSON.parse(body.content);
    expect(parsed.campaign_slug).toBe("outbound-q2-2026");
    expect(parsed.metrics.replies).toBe(12);
  });
});

// ─── archiveLesson ────────────────────────────────────────────────────────────

describe("archiveLesson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(okResponse({ ...BASE_ENTRY, category: "vauban_lesson" }));
  });

  const lesson: LessonInput = {
    title: "Cold outreach at Friday 5pm gets no replies",
    context: "Q2 outbound campaign to Series A CTOs",
    insight: "Send Tuesday–Thursday 9–11am only",
    applies_to: ["outbound", "email", "cold-outreach"],
    evidence: { samples: 47, reply_rate_delta: -0.18 },
  };

  it("calls archiveKnowledge with category vauban_lesson", async () => {
    const adapter = makeAdapter();
    await adapter.archiveLesson!(lesson);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.category).toBe("vauban_lesson");
  });

  it("includes 'lesson' tag plus applies_to items", async () => {
    const adapter = makeAdapter();
    await adapter.archiveLesson!(lesson);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tags).toContain("lesson");
    expect(body.tags).toContain("outbound");
    expect(body.tags).toContain("email");
    expect(body.tags).toContain("cold-outreach");
  });

  it("serializes the full LessonInput as content JSON", async () => {
    const adapter = makeAdapter();
    await adapter.archiveLesson!(lesson);

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    const parsed = JSON.parse(body.content);
    expect(parsed.title).toBe("Cold outreach at Friday 5pm gets no replies");
    expect(parsed.evidence.samples).toBe(47);
  });
});
