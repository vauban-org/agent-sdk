import { describe, expect, it } from "vitest";
import type { AttentionGate, ProactiveTriggerPort } from "../src/proactive/ports.js";
import type { ProactiveCandidate } from "../src/proactive/types.js";

describe("proactive ports", () => {
  it("an AttentionGate classifies a candidate", async () => {
    const gate: AttentionGate = {
      classify: () => ({ class: "silent", reason: "test" }),
    };
    const c: ProactiveCandidate = { source: "turn", subject: "x", payload: {}, observedAt: "t" };
    expect((await gate.classify(c)).class).toBe("silent");
  });

  it("a trigger starts and emits candidates", async () => {
    const emitted: ProactiveCandidate[] = [];
    const trigger: ProactiveTriggerPort = {
      source: "turn",
      async start(emit) {
        emit({ source: "turn", subject: "y", payload: {}, observedAt: "t" });
      },
      async stop() {},
    };
    await trigger.start((c) => emitted.push(c));
    expect(emitted).toHaveLength(1);
  });
});
