#!/usr/bin/env node
/**
 * Sprint-471 — package size guardrail.
 *
 * Measures raw and gzipped size of key dist/ files. Fails (exit 1) if
 * any file exceeds its declared ceiling. More honest than a bundler-
 * based check for Node libs (externals are not bundled; measuring the
 * emitted JS matches reality).
 */

import { statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const limits = [
  { path: "dist/index.js", rawMaxKb: 15, gzipMaxKb: 5 },
  { path: "dist/resilience/index.js", rawMaxKb: 5, gzipMaxKb: 2 },
  { path: "dist/testing/index.js", rawMaxKb: 5, gzipMaxKb: 2 },
  { path: "dist/tracing/traced-port.js", rawMaxKb: 10, gzipMaxKb: 4 },
];

let violations = 0;
const rows = [];
for (const { path, rawMaxKb, gzipMaxKb } of limits) {
  try {
    const abs = resolve(path);
    const raw = statSync(abs).size;
    const gz = gzipSync(readFileSync(abs)).length;
    const rawOk = raw <= rawMaxKb * 1024;
    const gzOk = gz <= gzipMaxKb * 1024;
    if (!rawOk || !gzOk) violations += 1;
    rows.push({
      file: path,
      raw_kb: (raw / 1024).toFixed(2),
      raw_limit: rawMaxKb,
      raw_ok: rawOk ? "OK" : "FAIL",
      gz_kb: (gz / 1024).toFixed(2),
      gz_limit: gzipMaxKb,
      gz_ok: gzOk ? "OK" : "FAIL",
    });
  } catch (err) {
    console.error(`✗ ${path}: ${(err instanceof Error ? err.message : String(err))}`);
    violations += 1;
  }
}

console.table(rows);

if (violations > 0) {
  console.error(`\n✗ ${violations} size violation(s). Tighten the code or bump the limits.`);
  process.exit(1);
}
console.log(`\n✓ All ${rows.length} file(s) within size limits.`);
