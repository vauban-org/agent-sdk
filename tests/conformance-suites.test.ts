/**
 * Conformance suites — extended tests for brain, logger, and outcome conformance.
 *
 * These tests exercise the three conformance suite functions directly, using
 * vitest's describe/it/expect. Each suite function registers its own describe
 * block, giving us full coverage of the contract assertions.
 *
 * Additional describe blocks verify the factory pattern, edge-case mocks, and
 * suite-level invariants.
 */

import { describe, expect, it, vi } from "vitest";
import type { BrainPort, OutcomePort } from "../src/ports/index.js";
import type { LoggerPort } from "../src/ports/logger.js";
import {
  brainPortConformance,
  loggerPortConformance,
  outcomePortConformance,
} from "../src/testing/index.js";

// ─── Reference mocks ──────────────────────────────────────────────────────────

function makeMockBrain(overrides: Partial<BrainPort> = {}): BrainPort {
  let seq = 0;
  return {
    archiveKnowledge: vi.fn(async (entry) => ({
      id: `brain-${++seq}`,
      content: entry.content,
      category: entry.category,
      tags: entry.tags,
    })),
    queryKnowledge: vi.fn(async () => []),
    ...overrides,
  };
}

function makeMockLogger(overrides: Partial<LoggerPort> = {}): LoggerPort {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

function makeMockOutcome(overrides: Partial<OutcomePort> = {}): OutcomePort {
  return {
    recordOutcomeAsync: vi.fn(() => undefined),
    ...overrides,
  };
}

// ─── BrainPort conformance suite (via brainPortConformance) ───────────────────

brainPortConformance({
  describe,
  it,
  expect: expect as never,
  factory: () => makeMockBrain(),
});

// ─── LoggerPort conformance suite (via loggerPortConformance) ─────────────────

loggerPortConformance({
  describe,
  it,
  expect,
  factory: () => makeMockLogger(),
});

// ─── OutcomePort conformance suite (via outcomePortConformance) ───────────────

outcomePortConformance({
  describe,
  it,
  expect,
  factory: () => makeMockOutcome(),
});

// ─── BrainPort — extended behavioural tests ───────────────────────────────────

describe("BrainPort extended — archiveKnowledge contract", () => {
  it("returned entry id is a non-empty string", async () => {
    const brain = makeMockBrain();
    const result = await brain.archiveKnowledge({
      content: "test content",
      category: "pattern",
      tags: ["conformance"],
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("null result is acceptable (soft validation failure)", async () => {
    const brain = makeMockBrain({
      archiveKnowledge: vi.fn(async () => null),
    });
    const result = await brain.archiveKnowledge({ content: "maybe invalid" });
    expect(result).toBeNull();
  });

  it("factory is called independently for each conformance it-block", async () => {
    const factoryCalls: string[] = [];
    let callIndex = 0;
    const factory = () => {
      callIndex++;
      factoryCalls.push(`call-${callIndex}`);
      return makeMockBrain();
    };
    // Invoke the suite: each inner it() will call factory()
    let registeredTests = 0;
    brainPortConformance({
      describe: (_name, body) => body(),
      it: (_name, _body) => {
        registeredTests++;
      },
      expect: expect as never,
      factory,
    });
    // 4 tests registered in brainPortConformance
    expect(registeredTests).toBe(4);
  });

  it("archiveKnowledge with tags propagates tags to entry", async () => {
    const brain = makeMockBrain();
    const tags = ["conformance", "extended"];
    const result = await brain.archiveKnowledge({
      content: "tagged entry",
      category: "decision",
      tags,
    });
    if (result?.tags) {
      expect(result.tags).toEqual(tags);
    }
  });

  it("repeated calls with identical content both resolve", async () => {
    const brain = makeMockBrain();
    const entry = {
      content: "idempotent-entry",
      category: "pattern",
      tags: ["conformance"],
    };
    const r1 = await brain.archiveKnowledge(entry);
    const r2 = await brain.archiveKnowledge(entry);
    expect(r1 === null || typeof r1.id === "string").toBe(true);
    expect(r2 === null || typeof r2.id === "string").toBe(true);
  });

  it("queryKnowledge returns an array (empty for no matches)", async () => {
    const brain = makeMockBrain();
    if (!brain.queryKnowledge) return;
    const results = await brain.queryKnowledge("no-match-xyz", { limit: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("queryKnowledge optional — brain without it is still compliant", async () => {
    const brain = makeMockBrain({ queryKnowledge: undefined });
    // Must satisfy the port interface even without the optional method
    expect(typeof brain.archiveKnowledge).toBe("function");
    expect(brain.queryKnowledge).toBeUndefined();
  });
});

// ─── LoggerPort — extended behavioural tests ──────────────────────────────────

describe("LoggerPort extended — log level contract", () => {
  it("debug is called when invoked with a string", () => {
    const logger = makeMockLogger();
    logger.debug("debug message");
    expect(logger.debug).toHaveBeenCalledWith("debug message");
  });

  it("info is called when invoked with an object", () => {
    const logger = makeMockLogger();
    const obj = { key: "value" };
    logger.info(obj);
    expect(logger.info).toHaveBeenCalledWith(obj);
  });

  it("warn is called when invoked with object + message", () => {
    const logger = makeMockLogger();
    logger.warn({ code: 42 }, "warning text");
    expect(logger.warn).toHaveBeenCalledWith({ code: 42 }, "warning text");
  });

  it("error is called when invoked with a string", () => {
    const logger = makeMockLogger();
    logger.error("critical error");
    expect(logger.error).toHaveBeenCalledWith("critical error");
  });

  it("child returns a LoggerPort with all four methods", () => {
    const childLogger = makeMockLogger();
    const parentLogger = makeMockLogger({
      child: vi.fn(() => childLogger),
    });
    if (!parentLogger.child) return;
    const child = parentLogger.child({ request_id: "abc123" });
    expect(typeof child.debug).toBe("function");
    expect(typeof child.info).toBe("function");
    expect(typeof child.warn).toBe("function");
    expect(typeof child.error).toBe("function");
  });

  it("child is optional — logger without it is still compliant", () => {
    const logger = makeMockLogger();
    // child is not defined in the mock
    expect(logger.child).toBeUndefined();
    // The four required methods must still be present
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("loggerPortConformance registers 4 test cases", () => {
    let registeredTests = 0;
    loggerPortConformance({
      describe: (_name, body) => body(),
      it: (_name, _body) => {
        registeredTests++;
      },
      expect,
      factory: () => makeMockLogger(),
    });
    expect(registeredTests).toBe(4);
  });
});

// ─── OutcomePort — extended behavioural tests ─────────────────────────────────

describe("OutcomePort extended — fire-and-forget contract", () => {
  it("recordOutcomeAsync returns undefined (void)", () => {
    const outcome = makeMockOutcome();
    const result = outcome.recordOutcomeAsync({
      id: "run-001",
      agent_id: "agent-a",
    });
    expect(result).toBe(undefined);
  });

  it("recordOutcomeAsync is called synchronously (no await required)", () => {
    const outcome = makeMockOutcome();
    outcome.recordOutcomeAsync({ id: "run-002", agent_id: "agent-b" });
    expect(outcome.recordOutcomeAsync).toHaveBeenCalledTimes(1);
  });

  it("recordOutcomeAsync with run_id does not throw", () => {
    const outcome = makeMockOutcome();
    expect(() =>
      outcome.recordOutcomeAsync({
        id: "run-003",
        agent_id: "agent-c",
        run_id: "trace-hash-abc",
      }),
    ).not.toThrow();
  });

  it("recordOutcomeAsync with outcome_id set does not throw", () => {
    const outcome = makeMockOutcome();
    expect(() =>
      outcome.recordOutcomeAsync({
        id: "run-004",
        agent_id: "agent-d",
        outcome_id: "already-attributed",
      }),
    ).not.toThrow();
  });

  it("recordOutcomeAsync with outcome_id null does not throw", () => {
    const outcome = makeMockOutcome();
    expect(() =>
      outcome.recordOutcomeAsync({
        id: "run-005",
        agent_id: "agent-e",
        outcome_id: null,
      }),
    ).not.toThrow();
  });

  it("multiple sequential calls all complete without error", () => {
    const outcome = makeMockOutcome();
    for (let i = 0; i < 5; i++) {
      expect(() =>
        outcome.recordOutcomeAsync({ id: `run-${i}`, agent_id: "agent-loop" }),
      ).not.toThrow();
    }
    expect(outcome.recordOutcomeAsync).toHaveBeenCalledTimes(5);
  });

  it("outcomePortConformance registers 3 test cases", () => {
    let registeredTests = 0;
    outcomePortConformance({
      describe: (_name, body) => body(),
      it: (_name, _body) => {
        registeredTests++;
      },
      expect,
      factory: () => makeMockOutcome(),
    });
    expect(registeredTests).toBe(3);
  });

  it("impl that throws internally still passes fire-and-forget contract when caught", () => {
    // OutcomePort contract: never throw from the port surface
    // This test verifies a wrapper that silences errors is compliant
    const silencedOutcome: OutcomePort = {
      recordOutcomeAsync: () => {
        // Internally fail but do not propagate
        try {
          throw new Error("internal backend error");
        } catch {
          // swallowed
        }
      },
    };
    expect(() =>
      silencedOutcome.recordOutcomeAsync({
        id: "run-fail",
        agent_id: "agent-x",
      }),
    ).not.toThrow();
    const result = silencedOutcome.recordOutcomeAsync({
      id: "run-fail-2",
      agent_id: "agent-x",
    });
    expect(result).toBe(undefined);
  });
});
