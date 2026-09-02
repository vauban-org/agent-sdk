import { describe, expect, it } from "vitest";
import type { BatteryTraceStep } from "../src/compute/battery/types.js";
import {
  type TraceStepSink,
  createAttentionGate,
  foldAttentionStep,
} from "../src/proactive/attention-gate.js";
import type { CriticalRule } from "../src/proactive/types.js";
import { RecordedClock } from "../src/replay/clock.js";
import type { TraceStep } from "../src/trace/schema.js";

const rules: CriticalRule[] = [
  { id: "run-fail-streak", when: (c) => (c.payload.failedRuns as number) >= 3 },
];

describe("createAttentionGate", () => {
  it("a matching critical rule forces push with the rule id", async () => {
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const v = await gate.classify({
      source: "event",
      subject: "forge",
      payload: { failedRuns: 3 },
      observedAt: "t",
    });
    expect(v).toEqual({ class: "push", reason: "run-fail-streak", ruleId: "run-fail-streak" });
  });

  it("a strong-recall non-critical candidate is digest", async () => {
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const v = await gate.classify({
      source: "turn",
      subject: "tokenomics",
      payload: {},
      observedAt: "t",
      recallStrength: 0.8,
    });
    expect(v.class).toBe("digest");
  });

  it("a weak-recall non-critical candidate is silent", async () => {
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const v = await gate.classify({
      source: "turn",
      subject: "x",
      payload: {},
      observedAt: "t",
      recallStrength: 0.2,
    });
    expect(v.class).toBe("silent");
  });

  it("learned salience never promotes to push (only rules do)", async () => {
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const v = await gate.classify({
      source: "turn",
      subject: "x",
      payload: {},
      observedAt: "t",
      recallStrength: 1.0,
    });
    expect(v.class).not.toBe("push");
  });
});

function fakeSink() {
  const fed: BatteryTraceStep[] = [];
  const sink: TraceStepSink = {
    async feed(step) {
      fed.push(step);
      return {
        ...step,
        index: fed.length - 1,
        prevStepHash: "0".repeat(64),
        stepHash: "s",
      } as TraceStep;
    },
  };
  return { fed, sink };
}

describe("foldAttentionStep (governed audit, ADR-ECO-068)", () => {
  it("folds ONE guard/guard_check hash-only step binding the verdict", async () => {
    const { fed, sink } = fakeSink();
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const verdict = await gate.classify({
      source: "event",
      subject: "forge",
      payload: { failedRuns: 3 },
      observedAt: "t",
    });
    const step = await foldAttentionStep(sink, "run-1", verdict, new RecordedClock([1000, 1005]));
    expect(fed).toHaveLength(1);
    expect(fed[0].phase).toBe("guard");
    expect(fed[0].type).toBe("guard_check");
    expect(fed[0].policy).toBe("hash-only");
    expect(fed[0].guardName).toBe("attention-gate");
    expect(fed[0].outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(step.runId).toBe("run-1");
  });

  it("replays byte-identical under a recorded clock (determinism + replay)", async () => {
    const gate = createAttentionGate({ rules, digestMinStrength: 0.6 });
    const verdict = await gate.classify({
      source: "turn",
      subject: "x",
      payload: {},
      observedAt: "t",
      recallStrength: 0.8,
    });
    const runOnce = async (): Promise<BatteryTraceStep> => {
      const { fed, sink } = fakeSink();
      await foldAttentionStep(sink, "run-1", verdict, new RecordedClock([1000, 1005]));
      return fed[0];
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a.outputHash).toBe(b.outputHash);
    expect(a).toEqual(b);
  });
});
