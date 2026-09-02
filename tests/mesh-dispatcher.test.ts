/**
 * tests/mesh-dispatcher.test.ts
 *
 * sprint-585 — dispatcher classifier + executor routing.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DefaultMeshDispatcher,
  MeshDispatchError,
  defaultClassifier,
} from "../src/mesh/dispatcher.js";

describe("defaultClassifier", () => {
  it("classifies audit/scan/monitor as ooda", () => {
    expect(defaultClassifier("audit cairo contracts")).toBe("ooda");
    expect(defaultClassifier("scan the codebase for vulnerabilities")).toBe("ooda");
    expect(defaultClassifier("monitor the validator health")).toBe("ooda");
    expect(defaultClassifier("watch for incidents")).toBe("ooda");
  });

  it("classifies multi-step as ooda (3+ terminators)", () => {
    expect(defaultClassifier("First do A. Then do B. Finally do C.")).toBe("ooda");
  });

  it("classifies short fetch-like requests as mcp-tool", () => {
    expect(defaultClassifier("get price BTC")).toBe("mcp-tool");
    expect(defaultClassifier("fetch user balance")).toBe("mcp-tool");
    expect(defaultClassifier("lookup tx hash")).toBe("mcp-tool");
  });

  it("classifies plain prose as llm-router", () => {
    expect(defaultClassifier("Generate a short story about a dog")).toBe("llm-router");
    expect(defaultClassifier("summarize this paragraph")).toBe("llm-router");
  });

  it("returns llm-router on empty input", () => {
    expect(defaultClassifier("")).toBe("llm-router");
    expect(defaultClassifier("   ")).toBe("llm-router");
  });
});

describe("DefaultMeshDispatcher.dispatch", () => {
  it("routes llm-router intent to llmExecutor with context appended", async () => {
    const llm = vi.fn(async (prompt: string) => `LLM: ${prompt}`);
    const d = new DefaultMeshDispatcher({ llmExecutor: llm });
    const r = await d.dispatch({
      kind: "llm-router",
      need: "hello",
      context: "ctx",
      deadline_ms: 1000,
    });
    expect(llm).toHaveBeenCalledOnce();
    expect(llm.mock.calls[0][0]).toContain("hello");
    expect(llm.mock.calls[0][0]).toContain("ctx");
    expect(r.output).toBe("LLM: hello\n\n[context]\nctx");
    expect(r.truncated).toBe(false);
  });

  it("routes ooda intent to oodaExecutor", async () => {
    const ooda = vi.fn(async () => "OODA done");
    const d = new DefaultMeshDispatcher({ oodaExecutor: ooda });
    const r = await d.dispatch({
      kind: "ooda",
      need: "audit",
      deadline_ms: 1000,
    });
    expect(ooda).toHaveBeenCalledOnce();
    expect(r.output).toBe("OODA done");
  });

  it("routes mcp-tool intent to registered tool", async () => {
    const getPrice = vi.fn(async (args: unknown) => `price=${String(args)}`);
    const d = new DefaultMeshDispatcher({ mcpTools: { get_price: getPrice } });
    const r = await d.dispatch({
      kind: "mcp-tool",
      need: "get price",
      toolName: "get_price",
      toolArgs: "BTC",
      deadline_ms: 1000,
    });
    expect(getPrice).toHaveBeenCalledWith("BTC");
    expect(r.output).toBe("price=BTC");
  });

  it("throws MeshDispatchError when mcp tool not found", async () => {
    const d = new DefaultMeshDispatcher({ mcpTools: {} });
    await expect(
      d.dispatch({
        kind: "mcp-tool",
        need: "x",
        toolName: "missing",
        deadline_ms: 1000,
      }),
    ).rejects.toBeInstanceOf(MeshDispatchError);
  });

  it("respects deadline_ms (truncated=true on slow executor)", async () => {
    const slow = vi.fn(
      async () => new Promise<string>((res) => setTimeout(() => res("late"), 200)),
    );
    const d = new DefaultMeshDispatcher({ llmExecutor: slow });
    const r = await d.dispatch({
      kind: "llm-router",
      need: "slow",
      deadline_ms: 20,
    });
    expect(r.truncated).toBe(true);
  });

  it("tracks cost via costPerMs", async () => {
    const d = new DefaultMeshDispatcher({
      llmExecutor: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "done";
      },
      costPerMs: 0.0001,
    });
    const r = await d.dispatch({
      kind: "llm-router",
      need: "x",
      deadline_ms: 1000,
    });
    expect(r.costEur).toBeGreaterThan(0);
    // Wall-clock — allow ~3ms tolerance for timer precision/jitter.
    expect(r.durationMs).toBeGreaterThanOrEqual(25);
  });

  it("caps cost at max_cost_eur", async () => {
    const d = new DefaultMeshDispatcher({
      llmExecutor: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "x";
      },
      costPerMs: 10, // huge — should be clamped
    });
    const r = await d.dispatch({
      kind: "llm-router",
      need: "x",
      deadline_ms: 1000,
      max_cost_eur: 0.01,
    });
    expect(r.costEur).toBe(0.01);
  });

  it("rejects invalid deadline_ms", async () => {
    const d = new DefaultMeshDispatcher();
    await expect(
      d.dispatch({ kind: "llm-router", need: "x", deadline_ms: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("classify() delegates to injected classifier", () => {
    const d = new DefaultMeshDispatcher({ classifier: () => "plugin" });
    expect(d.classify("any need")).toBe("plugin");
  });
});
