/**
 * gen_ai.* OTel semantic convention tests.
 *
 * Sprint: command-center:sprint-584:gen-ai-otel
 */

import { describe, expect, it, vi } from "vitest";
import {
  GEN_AI_AGENT_ID,
  GEN_AI_COST_USD,
  GEN_AI_DELEGATION_PARENT_RUN_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  // Constants
  GEN_AI_SYSTEM,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  type GenAiAttributes,
  // Helper
  setGenAiAttributes,
} from "../src/otel/attributes.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSpan() {
  const attrs: Record<string, string | number | boolean> = {};
  return {
    setAttribute: vi.fn((key: string, value: string | number | boolean) => {
      attrs[key] = value;
    }),
    _attrs: attrs,
  };
}

// ─── Attribute name constants match OTel spec strings exactly ─────────────────

describe("gen_ai.* attribute name constants", () => {
  it("GEN_AI_SYSTEM equals 'gen_ai.system'", () => {
    expect(GEN_AI_SYSTEM).toBe("gen_ai.system");
  });

  it("GEN_AI_REQUEST_MODEL equals 'gen_ai.request.model'", () => {
    expect(GEN_AI_REQUEST_MODEL).toBe("gen_ai.request.model");
  });

  it("GEN_AI_REQUEST_MAX_TOKENS equals 'gen_ai.request.max_tokens'", () => {
    expect(GEN_AI_REQUEST_MAX_TOKENS).toBe("gen_ai.request.max_tokens");
  });

  it("GEN_AI_RESPONSE_MODEL equals 'gen_ai.response.model'", () => {
    expect(GEN_AI_RESPONSE_MODEL).toBe("gen_ai.response.model");
  });

  it("GEN_AI_USAGE_INPUT_TOKENS equals 'gen_ai.usage.input_tokens'", () => {
    expect(GEN_AI_USAGE_INPUT_TOKENS).toBe("gen_ai.usage.input_tokens");
  });

  it("GEN_AI_USAGE_OUTPUT_TOKENS equals 'gen_ai.usage.output_tokens'", () => {
    expect(GEN_AI_USAGE_OUTPUT_TOKENS).toBe("gen_ai.usage.output_tokens");
  });

  it("GEN_AI_USAGE_TOTAL_TOKENS equals 'gen_ai.usage.total_tokens'", () => {
    expect(GEN_AI_USAGE_TOTAL_TOKENS).toBe("gen_ai.usage.total_tokens");
  });

  it("GEN_AI_OPERATION_NAME equals 'gen_ai.operation.name'", () => {
    expect(GEN_AI_OPERATION_NAME).toBe("gen_ai.operation.name");
  });

  it("GEN_AI_AGENT_ID equals 'gen_ai.agent.id'", () => {
    expect(GEN_AI_AGENT_ID).toBe("gen_ai.agent.id");
  });

  it("GEN_AI_DELEGATION_PARENT_RUN_ID equals 'gen_ai.delegation.parent_run_id'", () => {
    expect(GEN_AI_DELEGATION_PARENT_RUN_ID).toBe("gen_ai.delegation.parent_run_id");
  });

  it("GEN_AI_COST_USD equals 'gen_ai.cost.usd'", () => {
    expect(GEN_AI_COST_USD).toBe("gen_ai.cost.usd");
  });
});

// ─── setGenAiAttributes — span integration ────────────────────────────────────

describe("setGenAiAttributes", () => {
  it("sets all provided fields on the span", () => {
    const span = makeMockSpan();
    const attrs: Partial<GenAiAttributes> = {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.request.max_tokens": 4096,
      "gen_ai.response.model": "claude-sonnet-4-6",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 80,
      "gen_ai.usage.total_tokens": 200,
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.id": "trading-agent/v1",
      "gen_ai.delegation.parent_run_id": "run-parent-abc",
      "gen_ai.cost.usd": 0,
    };

    setGenAiAttributes(span, attrs);

    expect(span.setAttribute).toHaveBeenCalledTimes(11);
    expect(span._attrs["gen_ai.system"]).toBe("anthropic");
    expect(span._attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(span._attrs["gen_ai.request.max_tokens"]).toBe(4096);
    expect(span._attrs["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(span._attrs["gen_ai.usage.input_tokens"]).toBe(120);
    expect(span._attrs["gen_ai.usage.output_tokens"]).toBe(80);
    expect(span._attrs["gen_ai.usage.total_tokens"]).toBe(200);
    expect(span._attrs["gen_ai.operation.name"]).toBe("chat");
    expect(span._attrs["gen_ai.agent.id"]).toBe("trading-agent/v1");
    expect(span._attrs["gen_ai.delegation.parent_run_id"]).toBe("run-parent-abc");
    expect(span._attrs["gen_ai.cost.usd"]).toBe(0);
  });

  it("skips undefined values — does not call setAttribute for missing fields", () => {
    const span = makeMockSpan();
    setGenAiAttributes(span, {
      "gen_ai.system": "groq",
      // all others undefined
    });

    expect(span.setAttribute).toHaveBeenCalledTimes(1);
    expect(span._attrs["gen_ai.system"]).toBe("groq");
  });

  it("handles empty attrs without errors", () => {
    const span = makeMockSpan();
    setGenAiAttributes(span, {});
    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it("uses attribute key constants — gen_ai.cost.usd set as 0 (stub until OutcomeTracker wires)", () => {
    const span = makeMockSpan();
    setGenAiAttributes(span, { "gen_ai.cost.usd": 0 });
    expect(span._attrs[GEN_AI_COST_USD]).toBe(0);
  });
});

// ─── Sprint B integration — delegation attribute exported ─────────────────────

describe("gen_ai.delegation.parent_run_id — Sprint B integration", () => {
  it("GEN_AI_DELEGATION_PARENT_RUN_ID is exported from attributes", () => {
    // Verifies the constant is the same string used by withDelegationAttribute
    // in trace-context.ts (Sprint B), ensuring consistency.
    expect(GEN_AI_DELEGATION_PARENT_RUN_ID).toBe("gen_ai.delegation.parent_run_id");
  });

  it("setGenAiAttributes correctly sets delegation parent_run_id on span", () => {
    const span = makeMockSpan();
    setGenAiAttributes(span, {
      [GEN_AI_DELEGATION_PARENT_RUN_ID]: "run-parent-xyz-789",
    });
    expect(span._attrs["gen_ai.delegation.parent_run_id"]).toBe("run-parent-xyz-789");
  });
});
