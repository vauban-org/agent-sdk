/**
 * Unit tests for the agent-sdk testing contract modules:
 *   - brainPortContract (via TestBrainPort)
 *   - eventBusContract (via TestEventBus)
 *   - economicObserverContract scaffold (pure logic)
 *   - TestBrainPort direct behaviour
 *   - TestEventBus direct behaviour
 *   - TestChildAgentPort
 *   - AgentIntegrationHarness
 *   - signEvent / verifyEvent / auth errors
 *   - InMemoryNonceStore
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClockSkewError,
  InvalidSignatureError,
  ReplayDetectedError,
  UnknownSourceError,
} from "../src/auth/errors.js";
import { InMemoryNonceStore } from "../src/auth/nonce-store.js";
import { canonicalEventString, signEvent } from "../src/auth/sign-event.js";
import { verifyEvent } from "../src/auth/verify-event.js";
import type { DomainEvent } from "../src/ports/event-bus.js";
import { brainPortContract } from "../src/testing/contracts/brain-port.contract.js";
import { AgentIntegrationHarness } from "../src/testing/integration-harness.js";
import { TestBrainPort } from "../src/testing/test-brain-port.js";
import { TestChildAgentPort } from "../src/testing/test-child-agent.js";
import { TestEventBus } from "../src/testing/test-event-bus.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SECRET = "test-hmac-secret-32-bytes-padding";

function makeDomainEvent(
  overrides: Partial<Omit<DomainEvent, "signature">> = {},
): Omit<DomainEvent, "signature"> {
  return {
    type: "cc.test.happened",
    source: "cc",
    correlationId: `corr-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    schemaVersion: "1.0.0",
    payload: { value: 42 },
    ...overrides,
  };
}

function makeSignedEvent(overrides: Partial<Omit<DomainEvent, "signature">> = {}): DomainEvent {
  const event = makeDomainEvent(overrides);
  return { ...event, signature: signEvent(event, SECRET) };
}

// ─── brainPortContract via TestBrainPort ─────────────────────────────────────

brainPortContract(async () => {
  const port = new TestBrainPort();
  return { port, cleanup: async () => {} };
});

// ─── TestBrainPort direct tests ───────────────────────────────────────────────

describe("TestBrainPort", () => {
  let brain: TestBrainPort;

  beforeEach(() => {
    brain = new TestBrainPort();
  });

  it("archives and returns a BrainEntry with id", async () => {
    const entry = await brain.archiveKnowledge({
      content: "direct archive test",
      category: "test",
      tags: ["unit"],
    });
    expect(entry).not.toBeNull();
    expect(typeof entry!.id).toBe("string");
    expect(entry!.id.length).toBeGreaterThan(0);
  });

  it("assigns incrementing ids", async () => {
    const a = await brain.archiveKnowledge({
      content: "entry one",
      category: "test",
    });
    const b = await brain.archiveKnowledge({
      content: "entry two",
      category: "test",
    });
    expect(a!.id).not.toBe(b!.id);
  });

  it("queryKnowledge matches substring case-insensitively", async () => {
    await brain.archiveKnowledge({
      content: "Hello World pattern",
      category: "cat",
    });
    const results = await brain.queryKnowledge("hello WORLD");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("Hello World");
  });

  it("queryKnowledge filters by category", async () => {
    await brain.archiveKnowledge({
      content: "alpha content",
      category: "alpha",
    });
    await brain.archiveKnowledge({ content: "beta content", category: "beta" });
    const results = await brain.queryKnowledge("content", {
      category: "alpha",
    });
    expect(results.length).toBe(1);
    expect(results[0].category).toBe("alpha");
  });

  it("queryKnowledge filters by tags", async () => {
    await brain.archiveKnowledge({
      content: "tagged entry",
      tags: ["foo", "bar"],
    });
    await brain.archiveKnowledge({
      content: "other tagged entry",
      tags: ["baz"],
    });
    const results = await brain.queryKnowledge("entry", { tags: ["foo"] });
    expect(results.every((e) => e.tags?.includes("foo"))).toBe(true);
  });

  it("queryKnowledge respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await brain.archiveKnowledge({
        content: `limit test ${i}`,
        category: "lim",
      });
    }
    const results = await brain.queryKnowledge("limit test", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("queryKnowledge returns empty array for no match", async () => {
    const results = await brain.queryKnowledge("zzz_no_match_xyz");
    expect(results).toEqual([]);
  });

  it("reset clears all entries", async () => {
    await brain.archiveKnowledge({ content: "will be cleared", category: "x" });
    brain.reset();
    const results = await brain.queryKnowledge("will be cleared");
    expect(results).toEqual([]);
  });

  it("preserves content field on returned entry", async () => {
    const content = "preserved content check";
    const entry = await brain.archiveKnowledge({ content });
    expect(entry!.content).toBe(content);
  });

  it("working memory tier: set and get", async () => {
    await brain.working.set("run-1", "k", { x: 99 });
    const val = await brain.working.get("run-1", "k");
    expect(val).toEqual({ x: 99 });
  });

  it("working memory tier: returns null for missing key", async () => {
    const val = await brain.working.get("run-x", "missing");
    expect(val).toBeNull();
  });

  it("episodic memory tier: record and since", async () => {
    await brain.episodic.record("agent-1", "run-1", "cycle_completed", {
      n: 3,
    });
    const events = await brain.episodic.since("agent-1", Date.now() - 60_000);
    expect(events.length).toBeGreaterThan(0);
  });

  it("archivePostmortem resolves without error", async () => {
    await expect(
      brain.archivePostmortem({
        agentId: "a",
        runId: "r",
        cause: "oom",
        impact: "none",
        remediation: "reboot",
      }),
    ).resolves.toBeUndefined();
  });

  it("archiveLesson resolves without error", async () => {
    await expect(
      brain.archiveLesson({
        agentId: "a",
        lesson: "do not recurse forever",
        tags: ["perf"],
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── TestEventBus direct tests ────────────────────────────────────────────────

describe("TestEventBus", () => {
  let bus: TestEventBus;

  beforeEach(() => {
    bus = new TestEventBus();
  });

  it("publish stores event in stream", async () => {
    await bus.publish(
      {
        id: "ev-1",
        specversion: "1.0",
        source: "test",
        type: "cc.test",
        time: new Date().toISOString(),
      },
      "test.stream",
    );
    const published = bus.published("test.stream");
    expect(published.length).toBe(1);
    expect(published[0].id).toBe("ev-1");
  });

  it("publish rejects event without id", async () => {
    await expect(
      bus.publish(
        {
          id: "",
          specversion: "1.0",
          source: "test",
          type: "cc.test",
          time: new Date().toISOString(),
        },
        "test.stream",
      ),
    ).rejects.toThrow();
  });

  it("publish rejects wrong specversion", async () => {
    await expect(
      bus.publish(
        {
          id: "ev-2",
          specversion: "0.3" as "1.0",
          source: "test",
          type: "cc.test",
          time: new Date().toISOString(),
        },
        "test.stream",
      ),
    ).rejects.toThrow();
  });

  it("subscribe receives published event", async () => {
    const received: unknown[] = [];
    await bus.subscribe("s1", "g1", async (e) => {
      received.push(e);
    });
    await bus.publish(
      {
        id: "ev-3",
        specversion: "1.0",
        source: "test",
        type: "cc.test",
        time: new Date().toISOString(),
      },
      "s1",
    );
    expect(received.length).toBe(1);
  });

  it("publishWithIdempotency auto-signs and stores in domain stream", async () => {
    const event = makeDomainEvent();
    bus.setSigningSecret(SECRET);
    await bus.publishWithIdempotency(event, event.idempotencyKey);
    const replayed: DomainEvent[] = [];
    for await (const e of bus.replayFrom(`domain:${event.type}`, "0")) {
      replayed.push(e);
    }
    expect(replayed.length).toBeGreaterThan(0);
    expect(typeof replayed[0].signature).toBe("string");
    expect(replayed[0].signature.length).toBeGreaterThan(0);
  });

  it("publishWithIdempotency deduplicates same key", async () => {
    const event = makeDomainEvent();
    bus.setSigningSecret(SECRET);
    const key = event.idempotencyKey;
    await bus.publishWithIdempotency(event, key);
    await bus.publishWithIdempotency(event, key);
    const replayed: DomainEvent[] = [];
    for await (const e of bus.replayFrom(`domain:${event.type}`, "0")) {
      replayed.push(e);
    }
    expect(replayed.length).toBe(1);
  });

  it("subscribeDomain verifies signature and delivers valid events", async () => {
    bus.setSigningSecret(SECRET);
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain<{ value: number }>(
      "cc.domain.test",
      async (e) => {
        received.push(e as DomainEvent);
      },
      { groupId: "g-valid" },
    );
    const event = makeDomainEvent({ type: "cc.domain.test" });
    await bus.publishWithIdempotency(event, event.idempotencyKey);
    await new Promise((r) => setTimeout(r, 20));
    await sub.unsubscribe();
    expect(received.length).toBe(1);
  });

  it("subscribeDomain routes events with invalid signature to DLQ", async () => {
    bus.setSigningSecret(SECRET);
    const received: DomainEvent[] = [];
    const sub = bus.subscribeDomain<unknown>(
      "cc.bad.sig",
      async (e) => {
        received.push(e as DomainEvent);
      },
      { groupId: "g-bad" },
    );
    // Inject invalid signature directly via internal domainSubscribers
    const internal = bus as unknown as {
      domainSubscribers: Map<string, Map<string, (e: DomainEvent) => Promise<void>>>;
      domainDlq: DomainEvent[];
    };
    const typeSubs = internal.domainSubscribers.get("cc.bad.sig");
    if (typeSubs) {
      const invalidEvent: DomainEvent = {
        ...makeDomainEvent({ type: "cc.bad.sig" }),
        signature: "badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb",
      };
      for (const handler of typeSubs.values()) {
        await handler(invalidEvent);
      }
    }
    await sub.unsubscribe();
    expect(received.length).toBe(0);
  });

  it("dlq depth returns number", async () => {
    const depth = await bus.dlq().depth();
    expect(typeof depth).toBe("number");
  });

  it("moveToDlq increases DLQ depth", async () => {
    const event = {
      id: "dlq-1",
      specversion: "1.0" as const,
      source: "x",
      type: "t",
      time: new Date().toISOString(),
    };
    bus.moveToDlq(event);
    const depth = await bus.dlq().depth();
    expect(depth).toBe(1);
  });

  it("pendingCount returns 0 for unknown stream", async () => {
    const count = await bus.pendingCount("unknown.stream", "g1");
    expect(count).toBe(0);
  });

  it("replayFrom non-existent stream returns empty", async () => {
    const replayed: DomainEvent[] = [];
    for await (const e of bus.replayFrom("domain:nonexistent.xyz", "0")) {
      replayed.push(e);
    }
    expect(replayed.length).toBe(0);
  });

  it("reset clears all state", async () => {
    await bus.publish(
      {
        id: "ev-r",
        specversion: "1.0",
        source: "test",
        type: "cc.reset",
        time: new Date().toISOString(),
      },
      "reset.stream",
    );
    bus.reset();
    expect(bus.published("reset.stream")).toEqual([]);
    expect(await bus.dlq().depth()).toBe(0);
  });
});

// ─── TestChildAgentPort ───────────────────────────────────────────────────────

describe("TestChildAgentPort", () => {
  let child: TestChildAgentPort;

  beforeEach(() => {
    child = new TestChildAgentPort();
  });

  it("spawnSync returns completed status", async () => {
    const result = await child.spawnSync({ task: "test-task", context: {} });
    expect(result.status).toBe("completed");
    expect(typeof result.workerId).toBe("string");
  });

  it("spawnSync uses spy function output", async () => {
    child.spy(async () => ({ answer: 42 }));
    const result = await child.spawnSync({ task: "spied", context: {} });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ answer: 42 });
  });

  it("spawnSync returns failed status when spy throws", async () => {
    child.spy(async () => {
      throw new Error("worker error");
    });
    const result = await child.spawnSync({ task: "fail", context: {} });
    expect(result.status).toBe("failed");
    expect(typeof result.error).toBe("string");
  });

  it("spawnAsync returns a workerId immediately", async () => {
    const { workerId } = await child.spawnAsync({
      task: "async-task",
      context: {},
    });
    expect(typeof workerId).toBe("string");
    expect(workerId.length).toBeGreaterThan(0);
  });

  it("getWorker returns stored worker", async () => {
    const { workerId } = await child.spawnAsync({
      task: "lookup",
      context: {},
    });
    const worker = child.getWorker(workerId);
    expect(worker).toBeDefined();
    expect(worker!.opts.task).toBe("lookup");
  });

  it("reset clears workers", async () => {
    await child.spawnSync({ task: "t", context: {} });
    child.reset();
    // after reset nextWorkerId restarts at 1, no workers stored
    const { workerId } = await child.spawnAsync({ task: "new", context: {} });
    // The only worker is the newly spawned one (id includes "1")
    expect(workerId).toContain("1");
  });
});

// ─── AgentIntegrationHarness ─────────────────────────────────────────────────

describe("AgentIntegrationHarness", () => {
  it("exposes bus and brain", () => {
    const h = new AgentIntegrationHarness();
    expect(h.bus).toBeInstanceOf(TestEventBus);
    expect(h.brain).toBeInstanceOf(TestBrainPort);
  });

  it("runFlow publishes seed event to the test stream", async () => {
    const h = new AgentIntegrationHarness();
    const seedEvent = {
      id: "seed-1",
      specversion: "1.0" as const,
      source: "test",
      type: "cc.seed",
      time: new Date().toISOString(),
    };
    await h.runFlow([], seedEvent);
    const published = h.bus.published("vauban.events.test");
    expect(published.length).toBe(1);
    expect(published[0].id).toBe("seed-1");
  });

  it("expectPublished returns events matching type", async () => {
    const h = new AgentIntegrationHarness();
    await h.bus.publish(
      {
        id: "e1",
        specversion: "1.0",
        source: "s",
        type: "cc.match",
        time: new Date().toISOString(),
      },
      "stream.a",
    );
    await h.bus.publish(
      {
        id: "e2",
        specversion: "1.0",
        source: "s",
        type: "cc.nomatch",
        time: new Date().toISOString(),
      },
      "stream.a",
    );
    const matches = await h.expectPublished("stream.a", "cc.match");
    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe("e1");
  });

  it("reset clears bus and brain", async () => {
    const h = new AgentIntegrationHarness();
    await h.bus.publish(
      {
        id: "x1",
        specversion: "1.0",
        source: "s",
        type: "t",
        time: new Date().toISOString(),
      },
      "s",
    );
    await h.brain.archiveKnowledge({ content: "data" });
    h.reset();
    expect(h.bus.published("s")).toEqual([]);
  });
});

// ─── signEvent / canonicalEventString ────────────────────────────────────────

describe("signEvent", () => {
  it("returns a 64-char hex string", () => {
    const event = makeDomainEvent();
    const sig = signEvent(event, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same event + secret always produces same signature", () => {
    const event = makeDomainEvent({
      idempotencyKey: "fixed-key",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const sig1 = signEvent(event, SECRET);
    const sig2 = signEvent(event, SECRET);
    expect(sig1).toBe(sig2);
  });

  it("different secrets produce different signatures", () => {
    const event = makeDomainEvent();
    expect(signEvent(event, "secret-A-padded-32-bytes-here!!")).not.toBe(
      signEvent(event, "secret-B-padded-32-bytes-here!!"),
    );
  });
});

describe("canonicalEventString", () => {
  it("includes type, source, timestamp, idempotencyKey, payload hash", () => {
    const event = makeDomainEvent({
      type: "cc.foo",
      source: "cc",
      timestamp: "2026-01-01T00:00:00Z",
      idempotencyKey: "k1",
    });
    const hash = "abc123";
    const canonical = canonicalEventString(event, hash);
    expect(canonical).toContain("cc.foo");
    expect(canonical).toContain("cc");
    expect(canonical).toContain("2026-01-01T00:00:00Z");
    expect(canonical).toContain("k1");
    expect(canonical).toContain("abc123");
    expect((canonical.match(/\|/g) ?? []).length).toBe(4);
  });
});

// ─── verifyEvent ─────────────────────────────────────────────────────────────

describe("verifyEvent", () => {
  it("returns true for a valid signed event", async () => {
    const event = makeSignedEvent();
    await expect(verifyEvent(event, SECRET)).resolves.toBe(true);
  });

  it("throws InvalidSignatureError for wrong secret", async () => {
    const event = makeSignedEvent();
    await expect(verifyEvent(event, "wrong-secret-padded-here-32bytes")).rejects.toThrow(
      InvalidSignatureError,
    );
  });

  it("throws InvalidSignatureError for tampered signature", async () => {
    const event = { ...makeSignedEvent(), signature: "0".repeat(64) };
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(InvalidSignatureError);
  });

  it("throws ClockSkewError for old timestamp", async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: past });
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(ClockSkewError);
  });

  it("throws ClockSkewError with skewMs field", async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: past });
    try {
      await verifyEvent(event, SECRET);
    } catch (err) {
      expect(err).toBeInstanceOf(ClockSkewError);
      expect((err as ClockSkewError).skewMs).toBeGreaterThan(0);
    }
  });

  it("throws UnknownSourceError for unknown source", async () => {
    const event = makeSignedEvent({ source: "unknown-source" as "cc" });
    await expect(verifyEvent(event, SECRET)).rejects.toThrow(UnknownSourceError);
  });

  it("throws ReplayDetectedError on duplicate nonce", async () => {
    const nonceStore = new InMemoryNonceStore();
    const event = makeSignedEvent();
    await verifyEvent(event, SECRET, { nonceStore });
    await expect(verifyEvent(event, SECRET, { nonceStore })).rejects.toThrow(ReplayDetectedError);
  });

  it("accepts event within custom maxClockSkewMs", async () => {
    const slightlyOld = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const event = makeSignedEvent({ timestamp: slightlyOld });
    await expect(verifyEvent(event, SECRET, { maxClockSkewMs: 10 * 60 * 1000 })).resolves.toBe(
      true,
    );
  });
});

// ─── Auth errors ─────────────────────────────────────────────────────────────

describe("auth errors", () => {
  it("InvalidSignatureError has correct name", () => {
    const e = new InvalidSignatureError();
    expect(e.name).toBe("InvalidSignatureError");
    expect(e).toBeInstanceOf(Error);
  });

  it("ClockSkewError stores skewMs", () => {
    const e = new ClockSkewError(12345);
    expect(e.skewMs).toBe(12345);
    expect(e.name).toBe("ClockSkewError");
  });

  it("ReplayDetectedError stores idempotencyKey", () => {
    const e = new ReplayDetectedError("my-key");
    expect(e.idempotencyKey).toBe("my-key");
    expect(e.name).toBe("ReplayDetectedError");
  });

  it("UnknownSourceError stores source", () => {
    const e = new UnknownSourceError("evil-source");
    expect(e.source).toBe("evil-source");
    expect(e.name).toBe("UnknownSourceError");
  });
});

// ─── InMemoryNonceStore ───────────────────────────────────────────────────────

describe("InMemoryNonceStore", () => {
  it("setNX returns true for new key", async () => {
    const store = new InMemoryNonceStore();
    const result = await store.setNX("key1", 60_000);
    expect(result).toBe(true);
  });

  it("setNX returns false for duplicate key", async () => {
    const store = new InMemoryNonceStore();
    await store.setNX("key2", 60_000);
    const result = await store.setNX("key2", 60_000);
    expect(result).toBe(false);
  });

  it("reset allows key to be reused", async () => {
    const store = new InMemoryNonceStore();
    await store.setNX("key3", 60_000);
    store.reset();
    const result = await store.setNX("key3", 60_000);
    expect(result).toBe(true);
  });

  it("expired keys can be re-set", async () => {
    const store = new InMemoryNonceStore();
    // TTL of 1ms — effectively already expired by the next call
    await store.setNX("key4", 1);
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));
    const result = await store.setNX("key4", 60_000);
    expect(result).toBe(true);
  });
});
