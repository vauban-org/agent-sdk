/**
 * toOtelSpan tests — sprint-521 Bloc 1.
 *
 * Verifies that RunStep → OTel span mapping follows OpenInference
 * semantic conventions (gen_ai.*).
 */

import { describe, it, expect } from "vitest";
import { toOtelSpan } from "../src/proof/otel.js";
import type { RunStep } from "../src/proof/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: "step-abc-123",
    run_id: "run-xyz-456",
    step_index: 2,
    parent_step_id: null,
    type: "decision",
    phase: "execution",
    status: "done",
    started_at: "2026-04-28T10:00:00.000Z",
    finished_at: "2026-04-28T10:00:01.500Z",
    duration_ms: 1500,
    payload: null,
    leaf_hash_poseidon: "0x553705d38a32cf531ca2ae343abf9e85d3ab515f63bc158c7cd20c66a4a2c8c",
    mcp_call_hash: null,
    retrieval_proof_hash: null,
    otel_trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    otel_span_id: "00f067aa0ba902b7",
    error_message: null,
    ...overrides,
  };
}

// ─── toOtelSpan ───────────────────────────────────────────────────────────────

describe("toOtelSpan", () => {
  it("maps traceId and spanId from step otel fields", () => {
    const step = makeStep();
    const span = toOtelSpan(step);
    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.spanId).toBe("00f067aa0ba902b7");
  });

  it("falls back to empty string when otel_trace_id is null", () => {
    const step = makeStep({ otel_trace_id: null, otel_span_id: null });
    const span = toOtelSpan(step);
    expect(span.traceId).toBe("");
    expect(span.spanId).toBe("");
  });

  it("sets gen_ai.system to vauban-command-center", () => {
    const span = toOtelSpan(makeStep());
    expect(span.attributes["gen_ai.system"]).toBe("vauban-command-center");
  });

  it("sets gen_ai.operation.name to step.type", () => {
    const step = makeStep({ type: "retrieval" });
    const span = toOtelSpan(step);
    expect(span.attributes["gen_ai.operation.name"]).toBe("retrieval");
  });

  it("sets gen_ai.response.id to step.id", () => {
    const span = toOtelSpan(makeStep());
    expect(span.attributes["gen_ai.response.id"]).toBe("step-abc-123");
  });

  it("sets run.id and run.step_index", () => {
    const span = toOtelSpan(makeStep());
    expect(span.attributes["run.id"]).toBe("run-xyz-456");
    expect(span.attributes["run.step_index"]).toBe(2);
  });

  it("sets run.step.phase when present", () => {
    const span = toOtelSpan(makeStep({ phase: "boot" }));
    expect(span.attributes["run.step.phase"]).toBe("boot");
  });

  it("omits run.step.phase when phase is null", () => {
    const span = toOtelSpan(makeStep({ phase: null }));
    expect(Object.prototype.hasOwnProperty.call(span.attributes, "run.step.phase")).toBe(false);
  });

  it("sets run.step.duration_ms when present", () => {
    const span = toOtelSpan(makeStep({ duration_ms: 500 }));
    expect(span.attributes["run.step.duration_ms"]).toBe(500);
  });

  it("omits run.step.duration_ms when null", () => {
    const span = toOtelSpan(makeStep({ duration_ms: null }));
    expect(Object.prototype.hasOwnProperty.call(span.attributes, "run.step.duration_ms")).toBe(false);
  });

  it("sets proof.leaf_hash_poseidon when present", () => {
    const leaf = "0x553705d38a32cf531ca2ae343abf9e85d3ab515f63bc158c7cd20c66a4a2c8c";
    const span = toOtelSpan(makeStep({ leaf_hash_poseidon: leaf }));
    expect(span.attributes["proof.leaf_hash_poseidon"]).toBe(leaf);
  });

  it("omits proof.leaf_hash_poseidon when null", () => {
    const span = toOtelSpan(makeStep({ leaf_hash_poseidon: null }));
    expect(Object.prototype.hasOwnProperty.call(span.attributes, "proof.leaf_hash_poseidon")).toBe(false);
  });

  it("sets proof.mcp_call_hash when present", () => {
    const span = toOtelSpan(makeStep({ mcp_call_hash: "0xdeadbeef" }));
    expect(span.attributes["proof.mcp_call_hash"]).toBe("0xdeadbeef");
  });

  it("sets proof.retrieval_proof_hash when present", () => {
    const span = toOtelSpan(makeStep({ retrieval_proof_hash: "0xcafebabe" }));
    expect(span.attributes["proof.retrieval_proof_hash"]).toBe("0xcafebabe");
  });

  it("sets exception.message when error_message is present", () => {
    const span = toOtelSpan(makeStep({ error_message: "timeout after 30s" }));
    expect(span.attributes["exception.message"]).toBe("timeout after 30s");
  });

  it("omits exception.message when error_message is null", () => {
    const span = toOtelSpan(makeStep({ error_message: null }));
    expect(Object.prototype.hasOwnProperty.call(span.attributes, "exception.message")).toBe(false);
  });

  it("sets run.step.started_at", () => {
    const span = toOtelSpan(makeStep());
    expect(span.attributes["run.step.started_at"]).toBe("2026-04-28T10:00:00.000Z");
  });

  it("sets run.step.finished_at when present", () => {
    const span = toOtelSpan(makeStep({ finished_at: "2026-04-28T10:00:02.000Z" }));
    expect(span.attributes["run.step.finished_at"]).toBe("2026-04-28T10:00:02.000Z");
  });

  it("omits run.step.finished_at when null", () => {
    const span = toOtelSpan(makeStep({ finished_at: null }));
    expect(Object.prototype.hasOwnProperty.call(span.attributes, "run.step.finished_at")).toBe(false);
  });

  it("attributes object has only string|number values (OTel wire contract)", () => {
    const span = toOtelSpan(makeStep());
    for (const [, v] of Object.entries(span.attributes)) {
      expect(typeof v === "string" || typeof v === "number").toBe(true);
    }
  });

  it("step.type=observation is mapped correctly", () => {
    const span = toOtelSpan(makeStep({ type: "observation" }));
    expect(span.attributes["gen_ai.operation.name"]).toBe("observation");
    expect(span.attributes["run.step.type"]).toBe("observation");
  });
});
