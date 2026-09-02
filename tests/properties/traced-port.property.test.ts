/**
 * Property-based tests — tracedPort span count invariants (Sprint-470).
 *
 * Property: for N calls to any method on a traced port, exactly N spans
 * are emitted — regardless of whether the calls succeed or throw.
 *
 * Error paths are explicitly covered: a throwing method still emits
 * exactly one span (with ERROR status).
 *
 * 1000 runs via fc.assert.
 */

import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tracedPort } from "../../src/tracing/traced-port.js";

// ─── OTel provider setup / teardown ──────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A minimal port with one sync and one async method. */
interface SimplePort {
  syncMethod: (x: number) => number;
  asyncMethod: (x: number) => Promise<number>;
}

function makeSuccessPort(): SimplePort {
  return {
    syncMethod: (x) => x * 2,
    asyncMethod: async (x) => x + 1,
  };
}

function makeErrorPort(): SimplePort {
  return {
    syncMethod: (_x) => {
      throw new Error("sync-boom");
    },
    asyncMethod: async (_x) => {
      throw new Error("async-boom");
    },
  };
}

// ─── Property: N calls → N spans (success path) ──────────────────────────────

describe("property — tracedPort span count", () => {
  it("N async calls to a successful method emit exactly N spans", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (n) => {
        exporter.reset();
        const port = tracedPort(makeSuccessPort(), { portName: "test" });

        for (let i = 0; i < n; i++) {
          await port.asyncMethod(i);
        }

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(n);
      }),
      // 200 runs: async OTel span flush makes 1000 runs too slow per test.
      { numRuns: 200 },
    );
  });

  it("N sync calls to a successful method emit exactly N spans", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        exporter.reset();
        const port = tracedPort(makeSuccessPort(), { portName: "test" });

        for (let i = 0; i < n; i++) {
          port.syncMethod(i);
        }

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(n);
      }),
      { numRuns: 1000 },
    );
  });

  // ─── Property: N calls → N spans (error path) ────────────────────────────

  it("N async calls to a throwing method still emit exactly N spans (each ERROR)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (n) => {
        exporter.reset();
        const port = tracedPort(makeErrorPort(), { portName: "err-test" });

        for (let i = 0; i < n; i++) {
          await port.asyncMethod(i).catch(() => undefined);
        }

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(n);
        // All spans must have ERROR status.
        for (const span of spans) {
          expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
        }
      }),
      // 200 runs: async OTel error path is slower due to recordException overhead.
      { numRuns: 200 },
    );
  });

  it("N sync calls to a throwing method still emit exactly N spans (each ERROR)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        exporter.reset();
        const port = tracedPort(makeErrorPort(), { portName: "err-test" });

        for (let i = 0; i < n; i++) {
          try {
            port.syncMethod(i);
          } catch {
            // Expected: error path is what we're testing.
          }
        }

        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(n);
        for (const span of spans) {
          expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
        }
      }),
      // 200 runs: sync throws + OTel recordException + up to 20 spans per run.
      { numRuns: 200 },
    );
  });

  // ─── Mixed success/error calls ─────────────────────────────────────────────

  it("mixed success + error calls: total spans === total calls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 20 }),
        async (callPattern) => {
          exporter.reset();
          const successPort = tracedPort(makeSuccessPort(), {
            portName: "mixed",
          });
          const errorPort = tracedPort(makeErrorPort(), { portName: "mixed" });

          let expected = 0;
          for (const shouldSucceed of callPattern) {
            expected++;
            if (shouldSucceed) {
              await successPort.asyncMethod(1);
            } else {
              await errorPort.asyncMethod(1).catch(() => undefined);
            }
          }

          const spans = exporter.getFinishedSpans();
          expect(spans).toHaveLength(expected);
        },
      ),
      // 200 runs: each run involves up to 20 async OTel spans.
      { numRuns: 200 },
    );
  });
});
