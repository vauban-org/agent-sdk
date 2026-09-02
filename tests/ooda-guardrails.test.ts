/**
 * tests/ooda-guardrails.test.ts
 *
 * Sprint-563: B1 — LLM Guardrails pre/post phase enforcement.
 */

import { describe, expect, it } from "vitest";
import {
  PII_GUARD,
  createMaxInputLengthGuard,
  guardrailViolationToEvent,
  runPostGuards,
  runPreGuards,
} from "../src/orchestration/ooda/guardrails.js";
import type { GuardrailDef } from "../src/orchestration/ooda/guardrails.js";

const fakeCtx = { agentId: "test", runId: "r1", cycleIndex: 0 } as any;

describe("runPreGuards", () => {
  it("returns null when all pre-guards pass", async () => {
    const passing: GuardrailDef<string> = {
      name: "always-pass",
      timing: "pre-phase",
      async check() {
        return { pass: true };
      },
    };

    const result = await runPreGuards([passing], "input", fakeCtx);
    expect(result).toBeNull();
  });

  it("returns violation when pre-guard fails", async () => {
    const failing: GuardrailDef<string> = {
      name: "no-long-input",
      timing: "pre-phase",
      async check(input: string) {
        return {
          pass: input.length < 100,
          reason: "Input too long",
          proofHash: "0xabc",
        };
      },
    };

    const result = await runPreGuards([failing], "x".repeat(200), fakeCtx);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("no-long-input");
    expect(result!.proofHash).toBe("0xabc");
  });

  it("skips post-phase guards when running pre-guards", async () => {
    const postOnly: GuardrailDef<string> = {
      name: "post-only",
      timing: "post-phase",
      async check() {
        return { pass: false, reason: "should not run" };
      },
    };

    const result = await runPreGuards([postOnly], "input", fakeCtx);
    expect(result).toBeNull();
  });

  it("returns first violation, not all", async () => {
    const g1: GuardrailDef<string> = {
      name: "first",
      timing: "pre-phase",
      async check() {
        return { pass: false, reason: "first fails" };
      },
    };
    const g2: GuardrailDef<string> = {
      name: "second",
      timing: "pre-phase",
      async check() {
        return { pass: false, reason: "second fails" };
      },
    };

    const result = await runPreGuards([g1, g2], "x", fakeCtx);
    expect(result!.name).toBe("first");
  });
});

describe("runPostGuards", () => {
  it("returns null when all post-guards pass", async () => {
    const passing: GuardrailDef<string, string> = {
      name: "always-pass",
      timing: "post-phase",
      async check() {
        return { pass: true };
      },
    };

    const result = await runPostGuards([passing], "output", fakeCtx);
    expect(result).toBeNull();
  });

  it("returns violation on post-guard fail", async () => {
    const failing: GuardrailDef<string, string> = {
      name: "no-pii",
      timing: "post-phase",
      async check(output: string) {
        return {
          pass: !output.includes("SSN"),
          reason: "PII detected",
        };
      },
    };

    const result = await runPostGuards([failing], "User SSN: 123-45-6789", fakeCtx);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("no-pii");
  });
});

describe("guardrailViolationToEvent", () => {
  it("emits CycleEventV011 guardrail_violated", () => {
    const event = guardrailViolationToEvent(
      {
        name: "test-guard",
        timing: "pre-phase",
        phase: "observe",
        reason: "test",
        proofHash: "0xdef",
      },
      "run-1",
      3,
    );

    expect(event.type).toBe("guardrail_violated");
    expect(event.proofHash).toBe("0xdef");
    expect(event.timing).toBe("pre-phase");
    expect(event.cycleIndex).toBe(3);
  });
});

describe("PII_GUARD", () => {
  it("passes on clean output", async () => {
    const result = await PII_GUARD.check("This is a normal response about expenses");
    expect(result.pass).toBe(true);
  });

  it("fails on Luhn-valid credit card numbers", async () => {
    // Valid test card: 4012888888881881 (Luhn passes)
    const result = await PII_GUARD.check("Payment made with card 4012888888881881");
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("credit card");
  });

  it("passes on non-Luhn number sequences", async () => {
    const result = await PII_GUARD.check("Invoice #1234567890123 for Q1");
    expect(result.pass).toBe(true);
  });
});

describe("createMaxInputLengthGuard", () => {
  it("passes when input is within limit", async () => {
    const guard = createMaxInputLengthGuard(100);
    const result = await guard.check("short");
    expect(result.pass).toBe(true);
  });

  it("fails when input exceeds limit", async () => {
    const guard = createMaxInputLengthGuard(10);
    const result = await guard.check("this is way too long");
    expect(result.pass).toBe(false);
  });
});
