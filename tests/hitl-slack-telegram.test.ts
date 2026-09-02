/**
 * Tests for packages/agent-sdk/src/hitl/slack.ts + telegram.ts + api.ts + callback-handlers.ts
 *
 * Covers:
 * - HMAC verify positive/negative (Slack + Telegram)
 * - Block Kit format snapshot
 * - Callback handler: simulated payload → hitlPort.resolve() called
 * - Idempotence: duplicate payload → only 1 resolve
 * - E2E: Slack approval payload → HITLPort state pending→approved
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SlackChannelConfig,
  buildBlockKit,
  createSlackCallbackHandler,
  sendHITLApprovalRequestSlack,
  verifySlackSignature,
} from "../src/hitl/slack.js";

import {
  buildTelegramText,
  createTelegramCallbackHandler,
  verifyTelegramSignature,
} from "../src/hitl/telegram.js";

import { parseCallbackData } from "../src/hitl/api.js";

import { MemoryHITLStateStore } from "../src/adapters/hitl/memory-state-store.js";
import type { HITLPort, HITLRequest, HITLState } from "../src/ports/hitl.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSlackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function makeTelegramSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeHITLRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    id: "req-001",
    agentSource: "ARCHITECT",
    question: "Approve Starknet contract deploy?",
    context: { contract: "vault_v2", network: "sepolia" },
    options: ["approve", "reject"],
    deadline: "2026-05-07T12:00:00Z",
    channel: "slack",
    ...overrides,
  };
}

// ─── verifySlackSignature ─────────────────────────────────────────────────────

describe("verifySlackSignature", () => {
  const secret = "test-slack-signing-secret";
  const body = "payload=hello";

  it("returns true for a valid signature within time window", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSlackSignature(secret, timestamp, body);
    expect(verifySlackSignature(body, timestamp, sig, secret)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSlackSignature(secret, timestamp, body);
    expect(verifySlackSignature("payload=tampered", timestamp, sig, secret)).toBe(false);
  });

  it("returns false for an expired timestamp (>5 min)", () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 400);
    const sig = makeSlackSignature(secret, oldTs, body);
    expect(verifySlackSignature(body, oldTs, sig, secret)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSlackSignature("other-secret", timestamp, body);
    expect(verifySlackSignature(body, timestamp, sig, secret)).toBe(false);
  });

  it("returns false for empty timestamp", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSlackSignature(secret, timestamp, body);
    expect(verifySlackSignature(body, "", sig, secret)).toBe(false);
  });

  it("returns false for empty signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature(body, timestamp, "", secret)).toBe(false);
  });
});

// ─── verifyTelegramSignature ──────────────────────────────────────────────────

describe("verifyTelegramSignature", () => {
  const secret = "test-telegram-callback-secret";
  const body =
    '{"callback_query":{"id":"1","data":"{\\"a\\":\\"req-001\\",\\"v\\":\\"approve\\"}"}}';

  it("returns true for a valid signature", () => {
    const sig = makeTelegramSignature(secret, body);
    expect(verifyTelegramSignature(body, sig, secret)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const sig = makeTelegramSignature(secret, body);
    expect(verifyTelegramSignature('{"tampered":true}', sig, secret)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const sig = makeTelegramSignature("other-secret", body);
    expect(verifyTelegramSignature(body, sig, secret)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyTelegramSignature(body, "", secret)).toBe(false);
  });

  it("returns false for empty secret", () => {
    const sig = makeTelegramSignature(secret, body);
    expect(verifyTelegramSignature(body, sig, "")).toBe(false);
  });
});

// ─── buildBlockKit snapshot ───────────────────────────────────────────────────

describe("buildBlockKit", () => {
  it("contains header + actions block with approve/reject buttons", () => {
    const blocks = buildBlockKit({
      agentSource: "ARCHITECT",
      question: "Deploy?",
      approvalId: "abcdef123456",
      costDisplay: "$1.23",
      payloadSummary: '{"key":"val"}',
      deadline: "2026-05-07T12:00:00Z",
    });

    const header = blocks.find((b) => (b as { type: string }).type === "header") as {
      type: string;
      text: { text: string };
    };
    expect(header.text.text).toContain("ARCHITECT");

    const actions = blocks.find((b) => (b as { type: string }).type === "actions") as {
      type: string;
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions).toBeDefined();

    const approveBtn = actions.elements.find((e) => e.action_id === "hitl_approve");
    const rejectBtn = actions.elements.find((e) => e.action_id === "hitl_reject");

    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();

    const approveVal = JSON.parse(approveBtn!.value) as {
      approval_id: string;
      action: string;
    };
    expect(approveVal.approval_id).toBe("abcdef123456");
    expect(approveVal.action).toBe("approve");

    const rejectVal = JSON.parse(rejectBtn!.value) as {
      approval_id: string;
      action: string;
    };
    expect(rejectVal.action).toBe("reject");
  });
});

// ─── buildTelegramText snapshot ───────────────────────────────────────────────

describe("buildTelegramText", () => {
  it("contains agent source and approval ID", () => {
    const text = buildTelegramText({
      agentSource: "BUILDER",
      question: "Anchor seal?",
      approvalId: "uuid-short",
      payloadSummary: "{}",
      deadline: "2026-05-07T12:00:00Z",
    });
    expect(text).toContain("BUILDER");
    // approvalId slice is MarkdownV2-escaped: "uuid-sho" → "uuid\-sho"
    expect(text).toContain("uuid\\-sho");
  });
});

// ─── parseCallbackData ────────────────────────────────────────────────────────

describe("parseCallbackData", () => {
  it("parses compact a/v format", () => {
    const result = parseCallbackData(JSON.stringify({ a: "req-001", v: "approve" }));
    expect(result).toEqual({ approvalId: "req-001", action: "approve" });
  });

  it("parses legacy approval_id/action format", () => {
    const result = parseCallbackData(JSON.stringify({ approval_id: "req-002", action: "reject" }));
    expect(result).toEqual({ approvalId: "req-002", action: "reject" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseCallbackData("not-json")).toBeNull();
  });

  it("returns null for missing approvalId", () => {
    expect(parseCallbackData(JSON.stringify({ v: "approve" }))).toBeNull();
  });

  it("returns null for invalid action", () => {
    expect(parseCallbackData(JSON.stringify({ a: "req-001", v: "skip" }))).toBeNull();
  });
});

// ─── Slack callback handler ───────────────────────────────────────────────────

describe("createSlackCallbackHandler", () => {
  const signingSecret = "slack-secret-xyz";
  let store: MemoryHITLStateStore;

  beforeEach(async () => {
    store = new MemoryHITLStateStore();
    await store.request(makeHITLRequest({ id: "req-001" }));
  });

  function makeSlackPayload(approvalId: string, action: string): string {
    const interaction = {
      actions: [
        {
          value: JSON.stringify({ approval_id: approvalId, action }),
        },
      ],
    };
    const payload = `payload=${encodeURIComponent(JSON.stringify(interaction))}`;
    return payload;
  }

  function makeSlackHeaders(body: string, secret: string): Record<string, string> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": makeSlackSignature(secret, timestamp, body),
    };
  }

  it("resolves pending→approved on approve click", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });

    const body = makeSlackPayload("req-001", "approve");
    const headers = makeSlackHeaders(body, signingSecret);

    const result = await handler({ rawBody: body, headers });
    expect(result.status).toBe(200);

    const state = await store.getState("req-001");
    expect(state).toBe("approved");
  });

  it("resolves pending→rejected on reject click", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });

    const body = makeSlackPayload("req-001", "reject");
    const headers = makeSlackHeaders(body, signingSecret);

    const result = await handler({ rawBody: body, headers });
    expect(result.status).toBe(200);

    const state = await store.getState("req-001");
    expect(state).toBe("rejected");
  });

  it("returns 401 for invalid signature", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });

    const body = makeSlackPayload("req-001", "approve");
    const headers = makeSlackHeaders(body, "wrong-secret");

    const result = await handler({ rawBody: body, headers });
    expect(result.status).toBe(401);

    // State must remain pending
    const state = await store.getState("req-001");
    expect(state).toBe("pending");
  });

  it("is idempotent: duplicate payload → 1 resolve, 2nd returns 200", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });

    const body = makeSlackPayload("req-001", "approve");
    const headers = makeSlackHeaders(body, signingSecret);

    const r1 = await handler({ rawBody: body, headers });
    expect(r1.status).toBe(200);

    // Second call with same payload (re-sign with fresh timestamp)
    const headers2 = makeSlackHeaders(body, signingSecret);
    const r2 = await handler({ rawBody: body, headers: headers2 });
    expect(r2.status).toBe(200);
    // Still approved (not errored)
    const state = await store.getState("req-001");
    expect(state).toBe("approved");
  });
});

// ─── Telegram callback handler ────────────────────────────────────────────────

describe("createTelegramCallbackHandler", () => {
  const botToken = "bot123:TEST";
  const callbackSecret = "tg-secret-abc";
  let store: MemoryHITLStateStore;

  beforeEach(async () => {
    store = new MemoryHITLStateStore();
    await store.request(makeHITLRequest({ id: "req-tg-001", channel: "telegram" }));
  });

  function makeTgPayload(approvalId: string, action: string): string {
    return JSON.stringify({
      callback_query: {
        id: "cq-123",
        data: JSON.stringify({ a: approvalId, v: action }),
      },
    });
  }

  // biome-ignore lint/suspicious/noDuplicateTestHooks: distinct setup concern (fetch mock) kept separate from the state-store beforeEach above.
  beforeEach(() => {
    // Mock Telegram answerCallbackQuery endpoint
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
  });

  it("resolves pending→approved on approve callback", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      callbackSecret,
    });

    const body = makeTgPayload("req-tg-001", "approve");
    const sig = makeTelegramSignature(callbackSecret, body);

    const result = await handler(body, { "x-telegram-hmac-sha256": sig });
    expect(result.status).toBe(200);

    const state = await store.getState("req-tg-001");
    expect(state).toBe("approved");
  });

  it("resolves pending→rejected on reject callback", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      callbackSecret,
    });

    const body = makeTgPayload("req-tg-001", "reject");
    const sig = makeTelegramSignature(callbackSecret, body);

    const result = await handler(body, { "x-telegram-hmac-sha256": sig });
    expect(result.status).toBe(200);

    const state = await store.getState("req-tg-001");
    expect(state).toBe("rejected");
  });

  it("returns 401 for missing signature when callbackSecret is set", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      callbackSecret,
    });

    const body = makeTgPayload("req-tg-001", "approve");
    const result = await handler(body, {});
    expect(result.status).toBe(401);

    const state = await store.getState("req-tg-001");
    expect(state).toBe("pending");
  });

  it("returns 401 for invalid signature", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      callbackSecret,
    });

    const body = makeTgPayload("req-tg-001", "approve");
    const result = await handler(body, {
      "x-telegram-hmac-sha256": "bad-sig",
    });
    expect(result.status).toBe(401);
  });

  it("is idempotent: duplicate callback → 2nd returns 200 without throwing", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      callbackSecret,
    });

    const body = makeTgPayload("req-tg-001", "approve");
    const sig = makeTelegramSignature(callbackSecret, body);

    await handler(body, { "x-telegram-hmac-sha256": sig });
    const r2 = await handler(body, { "x-telegram-hmac-sha256": sig });
    expect(r2.status).toBe(200);

    const state = await store.getState("req-tg-001");
    expect(state).toBe("approved");
  });

  it("handles update with no callback_query gracefully", async () => {
    const handler = createTelegramCallbackHandler({
      hitlPort: store,
      botToken,
      // No callbackSecret — no HMAC check
    });

    const body = JSON.stringify({ message: { text: "hello" } });
    const result = await handler(body, {});
    expect(result.status).toBe(200);
  });
});

// ─── E2E: sendHITLApprovalRequestSlack → HITLPort state ──────────────────────

describe("sendHITLApprovalRequestSlack E2E", () => {
  it("registers pending request in HITLPort and returns approvalId", async () => {
    const store = new MemoryHITLStateStore();
    const channel: SlackChannelConfig = {
      webhookUrl: "https://hooks.slack.test/mock",
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" }));

    const request = makeHITLRequest({ id: "req-e2e-001" });
    const result = await sendHITLApprovalRequestSlack({
      channel,
      hitlPort: store,
      request,
      costDisplayUsd: 2.5,
    });

    expect(result.approvalId).toBe("req-e2e-001");
    const state = await store.getState("req-e2e-001");
    expect(state).toBe("pending");
  });

  it("E2E: send → callback approve → state is approved", async () => {
    const signingSecret = "e2e-secret";
    const store = new MemoryHITLStateStore();
    const channel: SlackChannelConfig = {
      webhookUrl: "https://hooks.slack.test/mock",
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "" }));

    const request = makeHITLRequest({ id: "req-e2e-002" });
    await sendHITLApprovalRequestSlack({
      channel,
      hitlPort: store,
      request,
    });

    // State is pending after send
    expect(await store.getState("req-e2e-002")).toBe("pending");

    // Simulate Slack callback
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });

    const interaction = {
      actions: [
        {
          value: JSON.stringify({
            approval_id: "req-e2e-002",
            action: "approve",
          }),
        },
      ],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(interaction))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeSlackSignature(signingSecret, timestamp, body);

    const result = await handler({
      rawBody: body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sig,
      },
    });

    expect(result.status).toBe(200);
    expect(await store.getState("req-e2e-002")).toBe("approved");
  });
});
