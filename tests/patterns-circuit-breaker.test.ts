import { describe, expect, it, vi } from "vitest";
import type { OODAContext } from "../src/orchestration/ooda/types.js";
import { createSessionCircuitBreaker } from "../src/patterns/circuit-breaker/index.js";
import type { BrainPort } from "../src/ports/brain.js";

function makeCtx(): OODAContext {
  return {
    agentId: "test-agent",
    runId: "run-001",
    cycleIndex: 0,
    executionMode: "dry-run",
    isReplay: false,
    config: {},
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    skills: {},
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    insertStep: async () => ({ stepId: "s1" }),
    completeStep: async () => ({ leafHash: "0x0" }),
    errorStep: async () => undefined,
    notifySlack: async () => undefined,
  };
}

function makeMockBrain(): BrainPort {
  return { archiveKnowledge: vi.fn(async () => null) };
}

describe("SessionCircuitBreaker — état initial", () => {
  it("démarre CLOSED", () => {
    const cb = createSessionCircuitBreaker({ name: "cb" });
    expect(cb.snapshot().state).toBe("closed");
  });
  it("check proceed=true quand CLOSED sans threshold dépassé", async () => {
    const cb = createSessionCircuitBreaker({ name: "cb" });
    expect((await cb.check(makeCtx())).proceed).toBe(true);
  });
  it("name inclut le préfixe session-cb:", () => {
    expect(createSessionCircuitBreaker({ name: "x" }).name).toBe("session-cb:x");
  });
});

describe("SessionCircuitBreaker — déclenchements", () => {
  it("trip OPEN quand consecutiveErrors >= maxConsecutiveErrors", async () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 3 },
    });
    cb.recordError();
    cb.recordError();
    expect(cb.snapshot().state).toBe("closed");
    cb.recordError(); // 3e → trip
    expect(cb.snapshot().state).toBe("open");
  });
  it("check proceed=false quand OPEN dans resetAfterMs", async () => {
    let now = 0;
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      resetAfterMs: 5_000,
      _now: () => now,
    });
    cb.recordError();
    now = 3_000;
    const r = await cb.check(makeCtx());
    expect(r.proceed).toBe(false);
    expect(r.reason).toContain("OPEN");
  });
  it("trip OPEN quand tokenCount > maxTokens", () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxTokens: 100 },
    });
    cb.recordTokens(101);
    expect(cb.snapshot().state).toBe("open");
  });
  it("trip OPEN quand estimatedCostUsd > maxCostUsd", () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxCostUsd: 1.0 },
    });
    cb.recordTokens(1, 1.01);
    expect(cb.snapshot().state).toBe("open");
  });
  it("trip OPEN quand actionCount > maxActionCount", () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxActionCount: 2 },
    });
    cb.recordAction();
    cb.recordAction();
    cb.recordAction(); // 3e → dépasse
    expect(cb.snapshot().state).toBe("open");
  });
});

describe("SessionCircuitBreaker — half-open probe", () => {
  it("OPEN → HALF-OPEN après resetAfterMs, check proceed=true", async () => {
    let now = 0;
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      resetAfterMs: 1_000,
      _now: () => now,
    });
    cb.recordError();
    now = 1_500;
    const r = await cb.check(makeCtx());
    expect(r.proceed).toBe(true);
    expect(cb.snapshot().state).toBe("half-open");
  });
  it("probe success → CLOSED + consecutiveErrors = 0", async () => {
    let now = 0;
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      resetAfterMs: 1_000,
      _now: () => now,
    });
    cb.recordError();
    now = 1_500;
    await cb.check(makeCtx());
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().consecutiveErrors).toBe(0);
  });
  it("probe failure → re-trip OPEN", async () => {
    let now = 0;
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      resetAfterMs: 1_000,
      _now: () => now,
    });
    cb.recordError();
    now = 1_500;
    await cb.check(makeCtx());
    cb.recordError();
    expect(cb.snapshot().state).toBe("open");
  });
});

describe("SessionCircuitBreaker — recordSuccess reset", () => {
  it("ne trip pas avec alternance erreur/success", () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 3 },
    });
    cb.recordError();
    cb.recordSuccess();
    cb.recordError();
    cb.recordSuccess();
    cb.recordError();
    expect(cb.snapshot().state).toBe("closed");
  });
});

describe("SessionCircuitBreaker — onTrip callback", () => {
  it("appelle onTrip avec snapshot quand trip", () => {
    const onTrip = vi.fn();
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      onTrip,
    });
    cb.recordError();
    expect(onTrip).toHaveBeenCalledOnce();
    const snap = onTrip.mock.calls[0]?.[0] as ReturnType<typeof cb.snapshot>;
    expect(snap.state).toBe("open");
  });
  it("n'appelle pas onTrip deux fois pour le même trip", () => {
    const onTrip = vi.fn();
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      onTrip,
    });
    cb.recordError();
    cb.recordError(); // already open
    expect(onTrip).toHaveBeenCalledOnce();
  });
});

describe("SessionCircuitBreaker — Brain logging", () => {
  it("appelle brain.archiveKnowledge au trip (fire-and-forget)", async () => {
    const brain = makeMockBrain();
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
      brain,
    });
    cb.recordError();
    await Promise.resolve();
    expect(brain.archiveKnowledge).toHaveBeenCalled();
  });
});

describe("SessionCircuitBreaker — reset()", () => {
  it("reset() remet à CLOSED et efface les métriques", async () => {
    const cb = createSessionCircuitBreaker({
      name: "cb",
      thresholds: { maxConsecutiveErrors: 1 },
    });
    cb.recordError();
    cb.reset();
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().tokenCount).toBe(0);
    expect((await cb.check(makeCtx())).proceed).toBe(true);
  });
});
