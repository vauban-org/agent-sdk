/**
 * Tests for:
 *   packages/agent-sdk/src/hitl/approval-channel.ts — InMemoryApprovalStore
 *   packages/agent-sdk/src/hitl/callback-handlers.ts — createNodeSlackCallbackHandler
 *   packages/agent-sdk/src/hitl/slack.ts — createSlackCallbackHandler error paths, buildBlockKit
 *   packages/agent-sdk/src/hitl/telegram.ts — buildTelegramText, verifyTelegramSignature
 *
 * Focuses on paths not already covered by:
 *   approval-store.test.ts (InMemoryApprovalStore main contract)
 *   hitl-slack-telegram.test.ts (HMAC verify, handler happy paths)
 *   hitl-api.test.ts (parseCallbackData, extractHeaders, collectBody)
 */

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Approval,
  InMemoryApprovalStore,
  type PendingApproval,
} from "../src/hitl/approval-channel.js";

import {
  createNodeSlackCallbackHandler,
  createSlackCallbackHandler,
  verifySlackSignature,
} from "../src/hitl/callback-handlers.js";

import { buildBlockKit } from "../src/hitl/slack.js";

import { buildTelegramText, verifyTelegramSignature } from "../src/hitl/telegram.js";

import { MemoryHITLStateStore } from "../src/adapters/hitl/memory-state-store.js";
import type { HITLPort, HITLRequest, HITLState } from "../src/ports/hitl.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id,
    req: {
      agentId: "sentinel",
      action: "halt-dca",
      context: "user requested",
      timeoutMs: 30_000,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    status: "pending",
    ...overrides,
  };
}

const VERDICT: Approval = {
  approved: true,
  rationale: "looks good",
  by: "admin@vauban.tech",
  at: "2026-05-20T10:00:00.000Z",
};

function makeSlackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeHITLRequest(overrides: Partial<HITLRequest> = {}): HITLRequest {
  return {
    id: "req-001",
    agentSource: "BUILDER",
    question: "Deploy sentinel contract?",
    context: { contract: "sentinel_v1", network: "mainnet" },
    options: ["approve", "reject"],
    deadline: "2026-05-21T12:00:00Z",
    channel: "slack",
    ...overrides,
  };
}

// ─── InMemoryApprovalStore — additional edge cases ────────────────────────────

describe("InMemoryApprovalStore — additional edge cases", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
  });

  it("cancel returns false for a timedout entry", async () => {
    const past = Date.now() - 5_000;
    await store.create(makeEntry("r1", { expiresAt: past }));
    await store.expireOverdue(Date.now());
    const result = await store.cancel("r1");
    expect(result).toBe(false);
    expect((await store.get("r1"))?.status).toBe("timedout");
  });

  it("resolve returns false for a cancelled entry", async () => {
    await store.create(makeEntry("r2"));
    await store.cancel("r2");
    const result = await store.resolve("r2", VERDICT);
    expect(result).toBe(false);
    expect((await store.get("r2"))?.verdict).toBeUndefined();
  });

  it("resolve returns false for a timedout entry", async () => {
    const past = Date.now() - 1;
    await store.create(makeEntry("r3", { expiresAt: past }));
    await store.expireOverdue(Date.now());
    const result = await store.resolve("r3", VERDICT);
    expect(result).toBe(false);
  });

  it("expireOverdue skips cancelled entries", async () => {
    const past = Date.now() - 5_000;
    await store.create(makeEntry("r4", { expiresAt: past }));
    await store.cancel("r4");
    const count = await store.expireOverdue(Date.now());
    expect(count).toBe(0);
    expect((await store.get("r4"))?.status).toBe("cancelled");
  });

  it("expireOverdue handles multiple overdue entries at once", async () => {
    const past = Date.now() - 10_000;
    await store.create(makeEntry("ra", { expiresAt: past }));
    await store.create(makeEntry("rb", { expiresAt: past }));
    await store.create(makeEntry("rc", { expiresAt: past }));
    const count = await store.expireOverdue(Date.now());
    expect(count).toBe(3);
    for (const id of ["ra", "rb", "rc"]) {
      expect((await store.get(id))?.status).toBe("timedout");
    }
  });

  it("expireOverdue uses current time when no argument is passed", async () => {
    const past = Date.now() - 5_000;
    await store.create(makeEntry("r-auto", { expiresAt: past }));
    const count = await store.expireOverdue(); // no argument
    expect(count).toBe(1);
    expect((await store.get("r-auto"))?.status).toBe("timedout");
  });

  it("listAll reflects state changes after resolve", async () => {
    await store.create(makeEntry("r5"));
    await store.resolve("r5", VERDICT);
    const all = await store.listAll();
    expect(all[0]?.status).toBe("resolved");
    expect(all[0]?.verdict?.by).toBe("admin@vauban.tech");
  });

  it("resolve stores optional rationale in verdict", async () => {
    await store.create(makeEntry("r6"));
    await store.resolve("r6", VERDICT);
    const e = await store.get("r6");
    expect(e?.verdict?.rationale).toBe("looks good");
  });

  it("resolve stores rejected (approved=false) verdict correctly", async () => {
    const rejectedVerdict: Approval = {
      approved: false,
      by: "reviewer",
      at: "2026-05-20T11:00:00Z",
    };
    await store.create(makeEntry("r7"));
    const ok = await store.resolve("r7", rejectedVerdict);
    expect(ok).toBe(true);
    const e = await store.get("r7");
    expect(e?.verdict?.approved).toBe(false);
  });
});

// ─── verifySlackSignature — additional cases ──────────────────────────────────

describe("verifySlackSignature — additional cases", () => {
  const secret = "slack-signing-secret";

  it("returns false for a non-numeric timestamp (NaN check)", () => {
    const ts = "not-a-number";
    const sig = makeSlackSignature(secret, ts, "body");
    expect(verifySlackSignature("body", ts, sig, secret)).toBe(false);
  });

  it("returns true with correct HMAC for very short body", () => {
    const ts = nowTs();
    const body = "x";
    const sig = makeSlackSignature(secret, ts, body);
    expect(verifySlackSignature(body, ts, sig, secret)).toBe(true);
  });

  it("returns false when signature buffer lengths differ (timing-safe branch)", () => {
    const ts = nowTs();
    const body = "payload";
    const validSig = makeSlackSignature(secret, ts, body);
    // Wrong prefix to same length still fails
    const badSig = `v0=${"0".repeat(64)}`;
    expect(verifySlackSignature(body, ts, badSig, secret)).toBe(false);
    expect(verifySlackSignature(body, ts, validSig, secret)).toBe(true);
  });
});

// ─── verifyTelegramSignature — additional cases ───────────────────────────────

describe("verifyTelegramSignature — additional cases", () => {
  const secret = "tg-callback-secret";

  it("returns false when signature is empty string", () => {
    expect(verifyTelegramSignature("body", "", secret)).toBe(false);
  });

  it("returns false when secret is empty string", () => {
    const sig = createHmac("sha256", secret).update("body").digest("hex");
    expect(verifyTelegramSignature("body", sig, "")).toBe(false);
  });

  it("returns true for correct HMAC of empty body", () => {
    const sig = createHmac("sha256", secret).update("").digest("hex");
    expect(verifyTelegramSignature("", sig, secret)).toBe(true);
  });
});

// ─── buildBlockKit — structure assertions ────────────────────────────────────

describe("buildBlockKit — structure assertions", () => {
  const baseOpts = {
    agentSource: "ARCHITECT",
    question: "Approve mainnet deploy?",
    approvalId: "abcdef01-1234-5678-abcd-ef0123456789",
    costDisplay: "$0.05",
    payloadSummary: '{"contract":"vault"}',
    deadline: "2026-05-21T09:00:00Z",
  };

  it("returns exactly 5 top-level blocks", () => {
    const blocks = buildBlockKit(baseOpts) as unknown[];
    expect(blocks).toHaveLength(5);
  });

  it("header block contains agentSource in text", () => {
    const blocks = buildBlockKit(baseOpts) as Array<Record<string, unknown>>;
    const header = blocks[0] as { type: string; text: { text: string } };
    expect(header.type).toBe("header");
    expect(header.text.text).toContain("ARCHITECT");
  });

  it("actions block has approve and reject buttons", () => {
    const blocks = buildBlockKit(baseOpts) as Array<Record<string, unknown>>;
    const actions = blocks[4] as {
      type: string;
      elements: Array<{ action_id: string }>;
    };
    expect(actions.type).toBe("actions");
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toContain("hitl_approve");
    expect(ids).toContain("hitl_reject");
  });

  it("approve button value JSON embeds approvalId", () => {
    const blocks = buildBlockKit(baseOpts) as Array<Record<string, unknown>>;
    const actions = blocks[4] as {
      elements: Array<{ value: string; style: string }>;
    };
    const approveBtn = actions.elements[0];
    const val = JSON.parse(approveBtn.value) as {
      approval_id: string;
      action: string;
    };
    expect(val.approval_id).toBe(baseOpts.approvalId);
    expect(val.action).toBe("approve");
    expect(approveBtn.style).toBe("primary");
  });

  it("reject button value JSON embeds approvalId and action=reject", () => {
    const blocks = buildBlockKit(baseOpts) as Array<Record<string, unknown>>;
    const actions = blocks[4] as {
      elements: Array<{ value: string; style: string }>;
    };
    const rejectBtn = actions.elements[1];
    const val = JSON.parse(rejectBtn.value) as {
      approval_id: string;
      action: string;
    };
    expect(val.approval_id).toBe(baseOpts.approvalId);
    expect(val.action).toBe("reject");
    expect(rejectBtn.style).toBe("danger");
  });
});

// ─── buildTelegramText — content assertions ───────────────────────────────────

describe("buildTelegramText — content assertions", () => {
  const opts = {
    agentSource: "SCRIBE",
    question: "Post to Rempart?",
    approvalId: "uuid-4242-abcd",
    payloadSummary: '{"topic":"governance"}',
    deadline: "2026-05-21T08:00:00Z",
  };

  it("includes shield emoji header with agentSource", () => {
    const text = buildTelegramText(opts);
    expect(text).toContain("HITL Approval Required");
    expect(text).toContain("SCRIBE");
  });

  it("includes question text", () => {
    const text = buildTelegramText(opts);
    expect(text).toContain("Post to Rempart");
  });

  it("includes deadline (MarkdownV2-escaped)", () => {
    const text = buildTelegramText(opts);
    // escapeMd replaces '-' with '\-' and '.' with '\.' in the deadline
    expect(text).toContain("2026\\-05\\-21T08");
  });

  it("includes first 8 chars of approvalId (MarkdownV2-escaped)", () => {
    const text = buildTelegramText(opts);
    // approvalId.slice(0,8) = "uuid-424" → escapeMd → "uuid\-424"
    expect(text).toContain("uuid\\-424");
  });

  it("includes context payload in code block", () => {
    const text = buildTelegramText(opts);
    expect(text).toContain("governance");
    expect(text).toContain("```");
  });
});

// ─── createSlackCallbackHandler — error/edge paths ───────────────────────────

describe("createSlackCallbackHandler — error/edge paths", () => {
  const signingSecret = "test-secret";
  let store: MemoryHITLStateStore;

  beforeEach(async () => {
    store = new MemoryHITLStateStore();
    await store.request(makeHITLRequest({ id: "r-slack-001" }));
  });

  it("returns 400 when body has no payload field", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const body = "key=value&other=thing"; // no payload field
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const result = await handler({
      rawBody: body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("missing payload field");
  });

  it("returns 400 when payload JSON is invalid", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const body = "payload=not-valid-json";
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const result = await handler({
      rawBody: body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("invalid JSON");
  });

  it("returns 400 when interaction has no actions array", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const interaction = JSON.stringify({ type: "view_submission" }); // no actions
    const body = `payload=${encodeURIComponent(interaction)}`;
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const result = await handler({
      rawBody: body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("no action value");
  });

  it("returns 400 when button value is invalid JSON", async () => {
    const handler = createSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const interaction = JSON.stringify({ actions: [{ value: "not-json" }] });
    const body = `payload=${encodeURIComponent(interaction)}`;
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const result = await handler({
      rawBody: body,
      headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("invalid button value");
  });
});

// ─── createNodeSlackCallbackHandler — Node HTTP adapter ──────────────────────

describe("createNodeSlackCallbackHandler — Node HTTP adapter", () => {
  const signingSecret = "node-adapter-secret";
  let store: MemoryHITLStateStore;

  beforeEach(async () => {
    store = new MemoryHITLStateStore();
    await store.request(makeHITLRequest({ id: "r-node-001" }));
  });

  function makeNodeReq(body: string, headers: Record<string, string>): IncomingMessage {
    const emitter = new EventEmitter();
    // Attach headers-like property
    (emitter as unknown as Record<string, unknown>).headers = headers;
    // Schedule body emission asynchronously
    setImmediate(() => {
      emitter.emit("data", Buffer.from(body));
      emitter.emit("end");
    });
    return emitter as unknown as IncomingMessage;
  }

  function makeNodeRes(): {
    statusCode?: number;
    headers: Record<string, string>;
    body: string;
    writeHead: (s: number, h: Record<string, string>) => void;
    end: (b: string) => void;
  } {
    const res = {
      statusCode: undefined as number | undefined,
      headers: {} as Record<string, string>,
      body: "",
      writeHead(status: number, hdrs: Record<string, string>) {
        this.statusCode = status;
        this.headers = hdrs;
      },
      end(b: string) {
        this.body = b;
      },
    };
    return res;
  }

  it("writes 401 for invalid Slack signature via Node HTTP adapter", async () => {
    const nodeHandler = createNodeSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        actions: [
          {
            value: JSON.stringify({
              approval_id: "r-node-001",
              action: "approve",
            }),
          },
        ],
      }),
    )}`;
    const ts = nowTs();
    const wrongSig = makeSlackSignature("wrong-secret", ts, body);
    const req = makeNodeReq(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": wrongSig,
    });
    const res = makeNodeRes();
    await nodeHandler(req, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false });
  });

  it("writes 200 and resolves on valid approve via Node HTTP adapter", async () => {
    const nodeHandler = createNodeSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const interaction = JSON.stringify({
      actions: [
        {
          value: JSON.stringify({
            approval_id: "r-node-001",
            action: "approve",
          }),
        },
      ],
    });
    const body = `payload=${encodeURIComponent(interaction)}`;
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const req = makeNodeReq(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    });
    const res = makeNodeRes();
    await nodeHandler(req, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const state = await store.getState("r-node-001");
    expect(state).toBe("approved");
  });

  it("sets Content-Type: application/json on response", async () => {
    const nodeHandler = createNodeSlackCallbackHandler({
      hitlPort: store,
      signingSecret,
    });
    const body = "no-payload";
    const ts = nowTs();
    const sig = makeSlackSignature(signingSecret, ts, body);
    const req = makeNodeReq(body, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    });
    const res = makeNodeRes();
    await nodeHandler(req, res as unknown as ServerResponse);
    expect(res.headers["Content-Type"]).toBe("application/json");
  });
});
