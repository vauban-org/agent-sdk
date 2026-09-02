/**
 * Tests for the SDK remote-control module (preste remote-control T1).
 *
 * Covers the event schema, the inbox, the hub, the remote approval channel,
 * the HTTP/SSE reference transport, and the AgentLoop integration — the loop
 * emits SessionEvents and drains injected instructions mid-run.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLoop,
  type ProviderRouter,
  type ToolRegistry,
  createBudgetState,
} from "../src/index.js";
import {
  InMemoryInstructionInbox,
  type RemoteControlServerHandle,
  type SessionEvent,
  SessionEventSchema,
  __resetEventSeq,
  createRemoteApprovalChannel,
  createRemoteControlHub,
  createRemoteControlServer,
  makeEvent,
} from "../src/remote/index.js";
import { ToolRegistryImpl } from "../src/tools/index.js";

// ─── events.ts ────────────────────────────────────────────────────────────────

describe("SessionEvent schema", () => {
  it("makeEvent produces a schema-valid, monotonic-seq event", () => {
    __resetEventSeq();
    const a = makeEvent("run.start", {
      runId: "r1",
      agentId: "tester",
      startedAt: new Date().toISOString(),
    });
    const b = makeEvent("assistant.message", { content: "hi" });
    expect(SessionEventSchema.safeParse(a).success).toBe(true);
    expect(SessionEventSchema.safeParse(b).success).toBe(true);
    expect(b.seq).toBe(a.seq + 1); // monotonic
  });

  it("rejects a malformed event", () => {
    const bad = { type: "run.start", id: "x", seq: 0, ts: "now", data: {} };
    expect(SessionEventSchema.safeParse(bad).success).toBe(false);
  });
});

// ─── inbox.ts ─────────────────────────────────────────────────────────────────

describe("InMemoryInstructionInbox", () => {
  it("enqueues, drains FIFO, and reports size", () => {
    const inbox = new InMemoryInstructionInbox();
    inbox.enqueue("first", "remote");
    inbox.enqueue("second", "telegram", true);
    expect(inbox.size()).toBe(2);
    const drained = inbox.drain();
    expect(drained.map((d) => d.text)).toEqual(["first", "second"]);
    expect(drained[1].whisper).toBe(true);
    expect(inbox.size()).toBe(0); // drain empties
  });

  it("ignores empty / whitespace-only injections", () => {
    const inbox = new InMemoryInstructionInbox();
    inbox.enqueue("   ", "remote");
    inbox.enqueue("", "remote");
    expect(inbox.size()).toBe(0);
  });

  it("threads an optional steerId onto the drained Instruction (sprint-1067 t3-steerid-correlation)", () => {
    const inbox = new InMemoryInstructionInbox();
    inbox.enqueue("first", "remote", false, "steer-1");
    inbox.enqueue("second", "telegram", true); // no steerId supplied
    const [first, second] = inbox.drain();
    expect(first.steerId).toBe("steer-1");
    expect("steerId" in second).toBe(false); // absent, byte-identical to before
  });
});

// ─── port.ts — the hub ────────────────────────────────────────────────────────

describe("RemoteControlHub", () => {
  it("buffers events and replays backlog gap-free by seq", () => {
    __resetEventSeq();
    const hub = createRemoteControlHub();
    const e0 = makeEvent("assistant.message", { content: "a" });
    const e1 = makeEvent("assistant.message", { content: "b" });
    hub.emit(e0);
    hub.emit(e1);
    expect(hub.backlog()).toHaveLength(2);
    expect(hub.backlog(e0.seq)).toHaveLength(1); // only events after e0
    expect(hub.backlog(e0.seq)[0].seq).toBe(e1.seq);
  });

  it("fans events to live subscribers; unsubscribe stops delivery", () => {
    const hub = createRemoteControlHub();
    const seen: SessionEvent[] = [];
    const off = hub.subscribe((e) => seen.push(e));
    hub.emit(makeEvent("assistant.message", { content: "x" }));
    off();
    hub.emit(makeEvent("assistant.message", { content: "y" }));
    expect(seen).toHaveLength(1);
  });

  it("derives session state from the event stream", () => {
    const hub = createRemoteControlHub();
    hub.emit(
      makeEvent("run.start", {
        runId: "r1",
        agentId: "tester",
        startedAt: new Date().toISOString(),
      }),
    );
    hub.emit(
      makeEvent("run.step", {
        stepIndex: 0,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      }),
    );
    hub.emit(
      makeEvent("hitl.request", {
        requestId: "h1",
        action: "run_bash",
        context: "{}",
      }),
    );
    const s = hub.state();
    expect(s.runId).toBe("r1");
    expect(s.status).toBe("running");
    expect(s.stepCount).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.01, 6);
    expect(s.pendingHitl).toBe(1);
  });
});

// ─── approval.ts ──────────────────────────────────────────────────────────────

describe("RemoteApprovalChannel", () => {
  it("emits hitl.request on send and hitl.resolved on resolve", async () => {
    // SDK 3.0.0 canonical-only ; Vauban-extension hitl.* projects to
    // CUSTOM_HITL_* via toCanonicalEventType at the emit boundary.
    const hub = createRemoteControlHub();
    const events: SessionEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const chan = createRemoteApprovalChannel({ sink: hub });
    const id = await chan.send({
      agentId: "tester",
      action: "run_bash",
      context: '{"command":"ls"}',
      timeoutMs: 60_000,
    });
    expect(events.some((e) => e.type === "CUSTOM_HITL_REQUEST")).toBe(true);
    expect(await chan.poll(id)).toBeNull(); // pending
    expect(chan.resolve(id, true, "remote")).toBe(true);
    const verdict = await chan.poll(id);
    expect(verdict?.approved).toBe(true);
    expect(events.some((e) => e.type === "CUSTOM_HITL_RESOLVED")).toBe(true);
    chan.dispose();
  });

  it("timeout policy rejects fail-closed by default", async () => {
    const hub = createRemoteControlHub();
    const chan = createRemoteApprovalChannel({ sink: hub, timeoutMs: 40 });
    const id = await chan.send({
      agentId: "tester",
      action: "x",
      context: "{}",
      timeoutMs: 40,
    });
    await new Promise((r) => setTimeout(r, 160));
    expect((await chan.poll(id))?.approved).toBe(false);
    chan.dispose();
  });
});

// ─── http-server.ts ───────────────────────────────────────────────────────────

describe("createRemoteControlServer", () => {
  let handle: RemoteControlServerHandle | undefined;
  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });
  // port:0 lets the OS assign a free port, eliminating EADDRINUSE flakiness.
  const port = (): number => 0;

  it("serves health + state, streams events, accepts injections", async () => {
    const hub = createRemoteControlHub();
    handle = await createRemoteControlServer(hub, { port: port() });

    const health = await fetch(`${handle.url}/remote/health`);
    expect(health.status).toBe(200);

    // inject → lands in the inbox
    const inj = await fetch(`${handle.url}/remote/inject`, {
      method: "POST",
      body: JSON.stringify({ text: "do the thing" }),
    });
    expect(inj.status).toBe(200);
    expect(hub.inbox.size()).toBe(1);

    // SSE stream replays the backlog on connect — emit BEFORE connecting so
    // the event is delivered deterministically (no live-timing race).
    // SDK 3.0.0 canonical-only ; `assistant.message` is normalised to
    // `TEXT_MESSAGE_END` via toCanonicalEventType at the emit boundary.
    hub.emit(makeEvent("assistant.message", { content: "streamed" }));
    const res = await fetch(`${handle.url}/remote/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("TEXT_MESSAGE_END");
    expect(chunk).toContain("streamed");
    await reader.cancel();
  });

  it("rejects unauthenticated requests when a token is set", async () => {
    const hub = createRemoteControlHub();
    handle = await createRemoteControlServer(hub, {
      port: port(),
      token: "secret",
    });
    expect((await fetch(`${handle.url}/remote/state`)).status).toBe(401);
    const ok = await fetch(`${handle.url}/remote/state`, {
      headers: { Authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses a non-loopback bind without a token (fail closed)", async () => {
    const hub = createRemoteControlHub();
    await expect(createRemoteControlServer(hub, { host: "0.0.0.0", port: port() })).rejects.toThrow(
      /token/,
    );
  });

  // T6f — capability-scoped sub-tokens are accepted by the auth gate
  // and gated per-route by required scope.
  describe("capability-scoped sub-tokens (T6f)", () => {
    it("read-only sub-token can GET /remote/state, gets 403 on POST /remote/inject", async () => {
      const { mintSubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "read-only",
        ttlSec: 60,
      });

      // GET state — allowed
      const state = await fetch(`${handle.url}/remote/state`, {
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(state.status).toBe(200);

      // POST inject — forbidden (requires "full")
      const inj = await fetch(`${handle.url}/remote/inject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sub}` },
        body: JSON.stringify({ text: "anything" }),
      });
      expect(inj.status).toBe(403);
      const body = (await inj.json()) as {
        error: string;
        required: string;
        granted: string;
      };
      expect(body).toEqual({
        error: "forbidden",
        required: "full",
        granted: "read-only",
      });
    });

    it("approve-only sub-token can resolve HITL + veto, but cannot inject", async () => {
      const { mintSubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "approve-only",
        ttlSec: 60,
      });

      // POST veto — allowed
      const veto = await fetch(`${handle.url}/remote/veto/call-1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sub}` },
        body: JSON.stringify({ by: "collaborator" }),
      });
      expect(veto.status).toBe(200);

      // POST inject — forbidden
      const inj = await fetch(`${handle.url}/remote/inject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sub}` },
        body: JSON.stringify({ text: "no" }),
      });
      expect(inj.status).toBe(403);
    });

    it("forged sub-token under a different parent is rejected 401", async () => {
      const { mintSubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "wrong-parent",
        scope: "full",
        ttlSec: 60,
      });
      const r = await fetch(`${handle.url}/remote/state`, {
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(r.status).toBe(401);
    });

    it("expired sub-token is rejected 401", async () => {
      const { mintSubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "full",
        ttlSec: 1,
        now: () => Date.now() - 60_000, // minted 60s in the past, TTL 1s → expired
      });
      const r = await fetch(`${handle.url}/remote/state`, {
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(r.status).toBe(401);
    });

    it("/remote/health is unauthenticated even with token set", async () => {
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const h = await fetch(`${handle.url}/remote/health`);
      expect(h.status).toBe(200);
    });

    it("revoked sub-token is rejected on subsequent requests", async () => {
      const { mintSubToken, verifySubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "read-only",
        ttlSec: 60,
      });
      const jti = verifySubToken("parent-secret", sub).jti;
      expect(jti).toBeDefined();

      // Pre-revoke: read-only access works.
      const before = await fetch(`${handle.url}/remote/state`, {
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(before.status).toBe(200);

      // Revoke via parent token.
      const rev = await fetch(`${handle.url}/remote/revoke/${jti}`, {
        method: "POST",
        headers: { Authorization: "Bearer parent-secret" },
      });
      expect(rev.status).toBe(200);
      const revBody = (await rev.json()) as {
        revoked: boolean;
        alreadyRevoked: boolean;
      };
      expect(revBody.revoked).toBe(true);
      expect(revBody.alreadyRevoked).toBe(false);

      // After revocation: same sub-token is 401.
      const after = await fetch(`${handle.url}/remote/state`, {
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(after.status).toBe(401);
    });

    it("a read-only sub-token cannot revoke (403)", async () => {
      const { mintSubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "read-only",
        ttlSec: 60,
      });
      const r = await fetch(`${handle.url}/remote/revoke/some-jti`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sub}` },
      });
      expect(r.status).toBe(403);
    });

    it("accepts the token via ?token= query string (EventSource path)", async () => {
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "qstring-secret",
      });
      // No Authorization header — only ?token= query string.
      const r = await fetch(`${handle.url}/remote/state?token=qstring-secret`, {
        method: "GET",
      });
      expect(r.status).toBe(200);
    });

    it("CORS: OPTIONS preflight returns 204 with Access-Control headers for an allowed origin", async () => {
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
        allowedOrigins: ["https://preste.vauban.tech"],
      });
      const r = await fetch(`${handle.url}/remote/state`, {
        method: "OPTIONS",
        headers: { Origin: "https://preste.vauban.tech" },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://preste.vauban.tech");
      expect(r.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(r.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });

    it("CORS: rejects an origin not in the allowlist (no header echoed)", async () => {
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
        allowedOrigins: ["https://preste.vauban.tech"],
      });
      const r = await fetch(`${handle.url}/remote/health`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("CORS: wildcard origin echoes the request Origin verbatim", async () => {
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
        allowedOrigins: ["*"],
      });
      const r = await fetch(`${handle.url}/remote/health`, {
        headers: { Origin: "https://anywhere.dev" },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://anywhere.dev");
    });

    it("re-revoking a jti is idempotent (alreadyRevoked=true)", async () => {
      const { mintSubToken, verifySubToken } = await import("../src/remote/sub-token.js");
      const hub = createRemoteControlHub();
      handle = await createRemoteControlServer(hub, {
        port: port(),
        token: "parent-secret",
      });
      const sub = mintSubToken({
        parentToken: "parent-secret",
        scope: "read-only",
        ttlSec: 60,
      });
      const jti = verifySubToken("parent-secret", sub).jti;

      await fetch(`${handle.url}/remote/revoke/${jti}`, {
        method: "POST",
        headers: { Authorization: "Bearer parent-secret" },
      });
      const second = await fetch(`${handle.url}/remote/revoke/${jti}`, {
        method: "POST",
        headers: { Authorization: "Bearer parent-secret" },
      });
      const body = (await second.json()) as { alreadyRevoked: boolean };
      expect(body.alreadyRevoked).toBe(true);
    });
  });
});

// ─── AgentLoop integration ────────────────────────────────────────────────────

function noopRegistry(): ToolRegistry {
  const reg = new ToolRegistryImpl();
  reg.register({
    name: "noop",
    description: "no-op",
    parameters: z.object({ n: z.number() }).strict(),
    execute: async (a) => ({ ok: true, echo: (a as { n: number }).n }),
  });
  return reg;
}

describe("AgentLoop × remote-control", () => {
  it("emits run.start / run.step / run.finished to the event sink", async () => {
    const hub = createRemoteControlHub();
    const provider: ProviderRouter = {
      async complete() {
        return {
          provider: "mock",
          model: "mock",
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 3 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: noopRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      eventSink: hub,
    });
    const result = await loop.run("hello");
    expect(result.stopReason).toBe("complete");
    // SDK 2.28.0 default = canonical ; AgentLoop emits legacy makeEvent types,
    // the hub normalises at the emit boundary to AG-UI canonical.
    const types = hub.backlog().map((e) => e.type);
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("STEP_STARTED");
    expect(types).toContain("TEXT_MESSAGE_END");
    expect(types).toContain("RUN_FINISHED");
  });

  it("drains the instruction inbox mid-run — interrupt-and-redirect", async () => {
    const hub = createRemoteControlHub();
    // The remote client injects an instruction before the loop's 2nd step.
    let calls = 0;
    const seenUserMessages: string[] = [];
    const provider: ProviderRouter = {
      async complete(req) {
        calls += 1;
        for (const m of req.messages) {
          if (m.role === "user") seenUserMessages.push(m.content);
        }
        if (calls === 1) {
          // After step 1, simulate a remote injection arriving.
          hub.inbox.enqueue("also check the logs", "remote:phone");
          return {
            provider: "mock",
            model: "mock",
            content: "step 1",
            toolCalls: [{ id: "c1", name: "noop", args: { n: 1 } }],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        }
        return {
          provider: "mock",
          model: "mock",
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: noopRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      eventSink: hub,
      instructionInbox: hub.inbox,
    });
    await loop.run("initial task");
    // The injected instruction reached the model as a user message.
    expect(seenUserMessages.some((m) => m.includes("also check the logs"))).toBe(true);
    // And an instruction.injected event was emitted (CUSTOM_* in canonical default).
    expect(hub.backlog().some((e) => e.type === "CUSTOM_INSTRUCTION_INJECTED")).toBe(true);
  });

  it("drains a standalone InMemoryInstructionInbox mid-run — no RemoteControlHub required", async () => {
    // The ink CLI path (sprint-872:midturn-inject) wires a bare
    // InMemoryInstructionInbox when no --remote/--gateway hub is live; this
    // locks in that the drain-at-step-boundary contract holds without a
    // RemoteControlHub or eventSink in the loop.
    const inbox = new InMemoryInstructionInbox();
    let calls = 0;
    const seenUserMessages: string[] = [];
    const provider: ProviderRouter = {
      async complete(req) {
        calls += 1;
        for (const m of req.messages) {
          if (m.role === "user") seenUserMessages.push(m.content);
        }
        if (calls === 1) {
          inbox.enqueue("switch to the auth module", "cli:ink");
          return {
            provider: "mock",
            model: "mock",
            content: "step 1",
            toolCalls: [{ id: "c1", name: "noop", args: { n: 1 } }],
            usage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 0,
          };
        }
        return {
          provider: "mock",
          model: "mock",
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 0,
        };
      },
    };
    const loop = new AgentLoop({
      agentId: "tester",
      agentVersion: "test",
      systemPrompt: "sys",
      provider,
      tools: noopRegistry(),
      budget: createBudgetState({ maxSteps: 0 }),
      disableLoopDetection: true,
      instructionInbox: inbox,
    });
    await loop.run("initial task");
    // The injected instruction reached the model on the NEXT iteration, with
    // no hub and no eventSink wired at all.
    expect(seenUserMessages.some((m) => m.includes("switch to the auth module"))).toBe(true);
  });
});
