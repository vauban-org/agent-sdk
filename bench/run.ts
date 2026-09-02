/**
 * Micro-benchmarks for @vauban-org/agent-sdk hot paths.
 *
 * Sprint-471. Uses tinybench (stats: mean, variance, p50/p75/p99).
 * Baselines stored in bench/baseline.json; CI compares and fails on
 * regression > 5% via `pnpm run bench:check` (follow-up sprint).
 *
 * Run: `pnpm bench` (output human-readable + writes bench/results.json).
 */

import { writeFileSync } from "node:fs";
import { Bench } from "tinybench";
import { tracedPort } from "../src/tracing/traced-port.js";
import {
  circuitBreaker,
  idempotent,
  bulkhead,
  hashKey,
} from "../src/resilience/index.js";
import { keepSafeOnly, sanitizeExternalInput } from "../src/safety/sanitize.js";

const bench = new Bench({ time: 500 });

// ─── tracedPort overhead ─────────────────────────────────────────────────
const rawPort = { ping: async () => 42 };
const traced = tracedPort(rawPort, { portName: "bench" });
bench.add("tracedPort.ping (no OTel sdk installed)", async () => {
  await traced.ping();
});

// ─── circuitBreaker happy path ───────────────────────────────────────────
const cbFn = circuitBreaker(async () => 42, {
  name: "bench",
  failureThreshold: 5,
});
bench.add("circuitBreaker wrapper (closed, success)", async () => {
  await cbFn();
});

// ─── idempotent cache hit ────────────────────────────────────────────────
const idem = idempotent(async (x: number) => x * 2, {
  keyFor: (x) => String(x),
});
await idem(3); // prime cache
bench.add("idempotent cache hit", async () => {
  await idem(3);
});

// ─── bulkhead pass-through ───────────────────────────────────────────────
const bh = bulkhead(async () => 42, {
  name: "bench",
  maxConcurrent: 100,
});
bench.add("bulkhead wrapper (no contention)", async () => {
  await bh();
});

// ─── hashKey (sha256) ────────────────────────────────────────────────────
bench.add("hashKey({content, author, category})", () => {
  hashKey({ content: "x".repeat(200), author: "bench", category: "pattern" });
});

// ─── sanitize ─────────────────────────────────────────────────────────────
const items = Array.from({ length: 50 }, (_, i) => ({
  content: `Benign item ${i} — normal prose without triggers.`,
}));
bench.add("sanitizeExternalInput (50 items)", () => {
  sanitizeExternalInput(items);
});
bench.add("keepSafeOnly (50 items)", () => {
  keepSafeOnly(items);
});

await bench.run();

// ── Print ────────────────────────────────────────────────────────────────
console.table(
  bench.tasks.map((t) => ({
    name: t.name,
    "mean (µs)": ((t.result?.mean ?? 0) * 1_000).toFixed(2),
    p50: ((t.result?.p50 ?? 0) * 1_000).toFixed(2),
    p99: ((t.result?.p99 ?? 0) * 1_000).toFixed(2),
    hz: (t.result?.hz ?? 0).toFixed(0),
  })),
);

// ── Persist for CI comparison ────────────────────────────────────────────
const results = bench.tasks.map((t) => ({
  name: t.name,
  mean: t.result?.mean ?? 0,
  p50: t.result?.p50 ?? 0,
  p99: t.result?.p99 ?? 0,
  hz: t.result?.hz ?? 0,
}));
writeFileSync(
  new URL("./results.json", import.meta.url),
  JSON.stringify(
    { version: "0.1.0", capturedAt: new Date().toISOString(), results },
    null,
    2,
  ),
);
console.log(`\nResults → bench/results.json`);
