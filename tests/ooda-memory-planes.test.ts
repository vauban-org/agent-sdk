/**
 * OODA cycle loop — V12 memory-plane wiring (sprint-895, ADR-ECO-114).
 *
 * The loop, when `deps.memory` is present, must:
 *   - set a private WM goal slot at cycle start,
 *   - append an EM event per material observation / decision / error,
 *   - assert a Claim for a verifiable conclusion (feature-detected).
 *
 * Semantic-only hosts (no `deps.memory`) run unchanged (regression).
 *
 * The "full chain" describe block below additionally drives a real orient
 * phase through `withBrainContext`, wiring the LTM (semantic) plane into the
 * SAME cycle so a single `triggerCycle()` call exercises WM -> EM -> LTM
 * (query_knowledge) -> Claims end to end (command-center:sprint-895:phaseb-e2e-coverage).
 */

import { describe, expect, it, vi } from "vitest";
import { type DbClient, type OODAAgentConfig, createOODAAgent, noopLogger } from "../src/index.js";
import type {
  BrainCallResult,
  BrainChunk,
  OrientInputWithBrain,
} from "../src/orchestration/ooda/brain-context.js";
import { withBrainContext } from "../src/orchestration/ooda/brain-context.js";
import {
  type BrainPort,
  InMemoryClaimPort,
  InMemoryEpisodicMemory,
  InMemorySemanticMemory,
  InMemoryWorkingMemory,
} from "../src/ports/brain.js";
import type { LLMProviderPort } from "../src/ports/llm-provider.js";
import type { LoggerPort } from "../src/ports/logger.js";

const fakeDb: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) };
const stubLlm = {} as unknown as LLMProviderPort;

interface Planes {
  readonly memory: BrainPort;
  readonly working: InMemoryWorkingMemory;
  readonly episodic: InMemoryEpisodicMemory;
  readonly claims: InMemoryClaimPort;
}

function makePlanes(opts: { withClaims?: boolean } = {}): Planes {
  const working = new InMemoryWorkingMemory();
  const episodic = new InMemoryEpisodicMemory();
  const claims = new InMemoryClaimPort();
  const memory: BrainPort = {
    archiveKnowledge: async () => null,
    working,
    episodic,
    ...(opts.withClaims === false ? {} : { claims }),
  };
  return { memory, working, episodic, claims };
}

/** A logger stub whose warn() calls can be asserted (unlike noopLogger). */
function spyLogger(): LoggerPort & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Arithmetic agent with the memory planes injected + a verifiable outcome. */
function makeAgent(
  memory: BrainPort | undefined,
  opts: {
    throwInAct?: boolean;
    withOutcome?: boolean;
    agentId?: string;
    logger?: LoggerPort;
  } = {},
) {
  const config: OODAAgentConfig<unknown, number, number, number, number, number> = {
    agentId: opts.agentId ?? "mem-agent",
    intervalMs: 0,
    executionMode: "live", // live + in-memory fake ports: plane writes are the behavior under test (dry-run skips them by design)
    db: fakeDb,
    logger: opts.logger ?? noopLogger,
    deps: { llm: stubLlm, ...(memory ? { memory } : {}) },
    phases: {
      observe: { type: "observation", readOnly: true, fn: async () => 1 },
      orient: { type: "retrieval", readOnly: true, fn: async (i: number) => i + 1 },
      decide: { type: "decision", fn: async (i: number) => i + 1 },
      act: {
        type: "execution",
        fn: async (i: number) => {
          if (opts.throwInAct) throw new Error("act boom");
          return i + 1;
        },
      },
      feedback: { type: "feedback", fn: async (i: number) => i + 1 },
    },
    ...(opts.withOutcome
      ? {
          outcomeMapping: () => ({
            outcome_type: "task_completed",
            value_cents: 500,
            confidence: 0.9,
          }),
        }
      : {}),
  } as OODAAgentConfig<unknown, number, number, number, number, number>;
  return createOODAAgent(config);
}

describe("OODA loop — Episodic Memory journalling", () => {
  it("appends observation + decision events on a successful cycle", async () => {
    const { memory, episodic } = makePlanes();
    const agent = makeAgent(memory);
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("succeeded");
    const events = await episodic.query({ agentId: "mem-agent", sessionId: runId });
    const kinds = events.map((e) => e.eventType).sort();
    expect(kinds).toEqual(["decision", "observation"]);
  });

  it("appends an error event when a phase throws", async () => {
    const { memory, episodic } = makePlanes();
    const agent = makeAgent(memory, { throwInAct: true });
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("failed");
    const events = await episodic.query({
      agentId: "mem-agent",
      sessionId: runId,
      eventTypes: ["error"],
    });
    expect(events).toHaveLength(1);
    expect(String((events[0]?.content as Record<string, unknown>).error)).toContain("act boom");
  });
});

describe("OODA loop — Claims plane", () => {
  it("asserts a Claim for a verifiable conclusion when claims plane present", async () => {
    const { memory, claims } = makePlanes();
    const agent = makeAgent(memory, { withOutcome: true });
    await agent.triggerCycle({ dryRun: false });

    const asserted = await claims.query({ subject: "agent:mem-agent" });
    expect(asserted).toHaveLength(1);
    expect(asserted[0]?.predicate).toBe("produced-outcome:task_completed");
    expect(asserted[0]?.object).toBe("500");
    expect(asserted[0]?.scope).toBe("private");
  });

  it("skips the claim cleanly when the claims plane is absent", async () => {
    const { memory } = makePlanes({ withClaims: false });
    const agent = makeAgent(memory, { withOutcome: true });
    const { status } = await agent.triggerCycle({ dryRun: false });
    // No claims plane → no throw, cycle still succeeds.
    expect(status).toBe("succeeded");
  });
});

describe("OODA loop — semantic-only host regression", () => {
  it("runs unchanged when deps.memory is absent (no planes)", async () => {
    const agent = makeAgent(undefined);
    const { status } = await agent.triggerCycle({ dryRun: false });
    expect(status).toBe("succeeded");
  });
});

describe("OODA loop — integration (all planes)", () => {
  it("a driven cycle produces >=1 WM slot, >=1 EM event, >=1 claim", async () => {
    const { memory, working, episodic, claims } = makePlanes();
    const agent = makeAgent(memory, { withOutcome: true });
    const { runId } = await agent.triggerCycle({ dryRun: false });

    const slots = await working.list(runId);
    const events = await episodic.query({ agentId: "mem-agent", sessionId: runId });
    const asserted = await claims.query({ subject: "agent:mem-agent" });

    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots.some((s) => s.slotId === "goal")).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(asserted.length).toBeGreaterThanOrEqual(1);
  });
});

describe("OODA loop — structural digest fallback (unserializable observation)", () => {
  it("EM records digest 'unserializable' instead of throwing when observe output is circular", async () => {
    const { memory, episodic } = makePlanes();
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;

    const config: OODAAgentConfig<unknown, unknown, unknown, unknown, unknown, unknown> = {
      agentId: "mem-agent",
      intervalMs: 0,
      executionMode: "live", // live + in-memory fake ports: plane writes are the behavior under test (dry-run skips them by design)
      db: fakeDb,
      logger: noopLogger,
      deps: { llm: stubLlm, memory },
      phases: {
        observe: { type: "observation", readOnly: true, fn: async () => circular },
        orient: { type: "retrieval", readOnly: true, fn: async (i) => i },
        decide: { type: "decision", fn: async (i) => i },
        act: { type: "execution", fn: async (i) => i },
        feedback: { type: "feedback", fn: async (i) => i },
      },
    };
    const agent = createOODAAgent(config);
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("succeeded");
    const events = await episodic.query({
      agentId: "mem-agent",
      sessionId: runId,
      eventTypes: ["observation"],
    });
    expect(events).toHaveLength(1);
    expect((events[0]?.content as Record<string, unknown>).digest).toBe("unserializable");
  });
});

describe("OODA loop — plane write failures are fail-soft", () => {
  it("WM goal-slot set() failure logs a warning and the cycle still succeeds", async () => {
    const { memory, episodic, claims } = makePlanes();
    vi.spyOn(memory.working as InMemoryWorkingMemory, "set").mockRejectedValueOnce(
      new Error("WM down"),
    );
    const logger = spyLogger();
    const agent = makeAgent(memory, { withOutcome: true, logger });
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("succeeded");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId }),
      "ooda.cycle.wm_goal_set_failed",
    );
    // EM + Claims planes are unaffected by the WM failure.
    const events = await episodic.query({ agentId: "mem-agent", sessionId: runId });
    expect(events.length).toBeGreaterThan(0);
    const asserted = await claims.query({ subject: "agent:mem-agent" });
    expect(asserted).toHaveLength(1);
  });

  it("EM append() failure logs a warning and the cycle still succeeds", async () => {
    const { memory } = makePlanes();
    vi.spyOn(memory.episodic as InMemoryEpisodicMemory, "append").mockRejectedValueOnce(
      new Error("EM down"),
    );
    const logger = spyLogger();
    const agent = makeAgent(memory, { logger });
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("succeeded");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId, eventType: "observation" }),
      "ooda.cycle.em_append_failed",
    );
  });

  it("Claims assert() failure logs a warning and the cycle still succeeds", async () => {
    const { memory } = makePlanes();
    vi.spyOn(memory.claims as InMemoryClaimPort, "assert").mockRejectedValueOnce(
      new Error("Claims down"),
    );
    const logger = spyLogger();
    const agent = makeAgent(memory, { withOutcome: true, logger });
    const { runId, status } = await agent.triggerCycle({ dryRun: false });

    expect(status).toBe("succeeded");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId }),
      "ooda.cycle.claim_assert_failed",
    );
  });
});

describe("OODA loop — full WM -> EM -> LTM -> Claims chain (E2E)", () => {
  interface Observation {
    readonly topic: string;
  }

  it("a single driven cycle writes WM, appends EM, queries LTM via orient, and asserts a Claim", async () => {
    const working = new InMemoryWorkingMemory();
    const episodic = new InMemoryEpisodicMemory();
    const claims = new InMemoryClaimPort();
    const semantic = new InMemorySemanticMemory();

    // Seed the LTM (semantic) plane with a previously consolidated fact —
    // stands in for the engine-side WM->EM->LTM promotion (per
    // rules/knowledge/memory-planes.md, consolidation is never done by hand
    // from the SDK; this seed represents what consolidation would have
    // produced ahead of this cycle).
    await semantic.archive({
      content: "Q2 revenue consolidated: $1.2M ARR, up 18% QoQ",
      category: "consolidated-fact",
      tags: ["ltm", "revenue"],
    });

    const memory: BrainPort = {
      archiveKnowledge: (entry) => semantic.archive(entry),
      queryKnowledge: (q, filters) => semantic.query(q, filters),
      working,
      episodic,
      claims,
    };

    let capturedOrient: OrientInputWithBrain<Observation> | undefined;

    const config: OODAAgentConfig<
      unknown,
      Observation,
      OrientInputWithBrain<Observation>,
      number,
      number,
      number
    > = {
      agentId: "e2e-agent",
      intervalMs: 0,
      executionMode: "live", // live + in-memory fake ports: plane writes are the behavior under test (dry-run skips them by design)
      db: fakeDb,
      logger: noopLogger,
      deps: { llm: stubLlm, memory },
      phases: {
        observe: { type: "observation", readOnly: true, fn: async () => ({ topic: "revenue" }) },
        orient: {
          type: "retrieval",
          readOnly: true,
          fn: withBrainContext<Observation, OrientInputWithBrain<Observation>>(
            {
              enabled: true,
              query: (i) => i.topic,
              memory: { working, episodic },
              // Wires the LTM plane in: fetchBrainContext resolves via
              // queryKnowledge (query_knowledge), proving the semantic tier
              // is reachable from the very same orient phase that already
              // loads WM + EM — the full chain in one call.
              fetchBrainContext: async (q: string): Promise<BrainCallResult<BrainChunk[]>> => {
                const hits = await memory.queryKnowledge?.(q);
                const chunks: BrainChunk[] = (hits ?? []).map((h) => ({
                  entry_id: h.id,
                  content: h.content,
                  similarity: 0.91,
                }));
                return {
                  result: chunks,
                  mcp_call_hash: "e2e-mcp-hash",
                  retrieval_proof_hash: "e2e-retrieval-hash",
                };
              },
            },
            async (input) => {
              capturedOrient = input;
              return input;
            },
          ),
        },
        decide: { type: "decision", fn: async (oriented) => oriented.brainContext.length },
        act: { type: "execution", fn: async (n: number) => n },
        feedback: { type: "feedback", fn: async (n: number) => n },
      },
      outcomeMapping: () => ({
        outcome_type: "task_completed",
        value_cents: 500,
        confidence: 0.9,
      }),
    };

    const agent = createOODAAgent(config);
    const { runId, status } = await agent.triggerCycle({ dryRun: false });
    expect(status).toBe("succeeded");

    // WM: the run-goal slot was pinned at cycle start and is visible both
    // directly (working.list) and folded into the orient input.
    const slots = await working.list(runId);
    expect(slots.some((s) => s.slotId === "goal")).toBe(true);
    expect(capturedOrient?.workingMemoryGoal?.slotId).toBe("goal");

    // EM: the "observation" event (appended right after observe, before
    // orient runs) is visible both directly and in the orient episodic window.
    const events = await episodic.query({ agentId: "e2e-agent", sessionId: runId });
    const kinds = events.map((e) => e.eventType).sort();
    expect(kinds).toEqual(["decision", "observation"]);
    expect(capturedOrient?.episodicWindow?.some((e) => e.eventType === "observation")).toBe(true);

    // LTM: the seeded consolidated fact was retrieved via query_knowledge
    // inside the SAME orient call that also loaded WM + EM.
    expect(capturedOrient?.brainContext).toHaveLength(1);
    expect(capturedOrient?.brainContext[0]?.content).toContain("Q2 revenue consolidated");
    expect(capturedOrient?.brainContextRefs).toEqual([capturedOrient?.brainContext[0]?.entry_id]);

    // Claims: a verifiable outcome was asserted after the cycle completed.
    const asserted = await claims.query({ subject: "agent:e2e-agent" });
    expect(asserted).toHaveLength(1);
    expect(asserted[0]?.predicate).toBe("produced-outcome:task_completed");
    expect(asserted[0]?.scope).toBe("private");
  });
});
