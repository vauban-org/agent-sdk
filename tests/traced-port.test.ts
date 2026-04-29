/**
 * Tests for tracedPort (Sprint-460).
 *
 * Uses an in-memory span exporter to assert spans are emitted with the
 * right names, attributes, and statuses. Does NOT require the full
 * @opentelemetry/sdk-node — only the trace-base + in-memory-exporter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { tracedPort } from "../src/tracing/traced-port.js";
import type { BrainEntryInput, BrainPort } from "../src/ports/index.js";
import { BrainRateLimit } from "../src/errors.js";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

describe("tracedPort — BrainPort", () => {
  it("emits one OK span per archiveKnowledge call", async () => {
    const impl: BrainPort = {
      archiveKnowledge: async (entry: BrainEntryInput) => ({
        id: "e1",
        content: entry.content,
      }),
    };
    const traced = tracedPort(impl, { portName: "brain" });

    const result = await traced.archiveKnowledge({ content: "hello" });
    expect(result?.id).toBe("e1");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("brain.archiveKnowledge");
    expect(spans[0].attributes["gen_ai.system"]).toBe("brain");
    expect(spans[0].attributes["gen_ai.operation.name"]).toBe(
      "archiveKnowledge",
    );
    expect(spans[0].status.code).toBe(1); // OK
  });

  it("records span ERROR and re-throws on async failure", async () => {
    const boom = new BrainRateLimit({ retryAfterMs: 500 });
    const impl: BrainPort = {
      archiveKnowledge: async () => {
        throw boom;
      },
    };
    const traced = tracedPort(impl, { portName: "brain" });

    await expect(traced.archiveKnowledge({ content: "x" })).rejects.toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // ERROR
    expect(spans[0].attributes["vauban.port.error.port"]).toBe("brain");
    expect(spans[0].attributes["vauban.port.error.retryable"]).toBe(true);
  });

  it("forwards non-function fields unchanged", () => {
    const impl = {
      archiveKnowledge: async () => null,
      version: "1.2.3",
    };
    const traced = tracedPort(impl, { portName: "brain" });
    expect(traced.version).toBe("1.2.3");
  });

  it("invokes attributeHook with span + method + args + result", async () => {
    const captured: Array<{
      method: string;
      args: readonly unknown[];
      result: unknown;
    }> = [];
    const impl: BrainPort = {
      archiveKnowledge: async (entry) => ({ id: "e1", content: entry.content }),
    };
    const traced = tracedPort(impl, {
      portName: "brain",
      attributeHook: ({ span, method, args, result }) => {
        captured.push({ method, args, result });
        span.setAttribute(
          "vauban.entry.content_len",
          (args[0] as BrainEntryInput).content.length,
        );
      },
    });

    await traced.archiveKnowledge({ content: "hello-world" });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("archiveKnowledge");
    const spans = exporter.getFinishedSpans();
    expect(spans[0].attributes["vauban.entry.content_len"]).toBe(11);
  });
});

describe("tracedPort — sync methods", () => {
  it("still creates a span for synchronous methods", () => {
    const impl = {
      compute: (x: number) => x * 2,
    };
    const traced = tracedPort(impl, { portName: "compute-svc" });
    expect(traced.compute(21)).toBe(42);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("compute-svc.compute");
    expect(spans[0].status.code).toBe(1);
  });
});
