// @ts-check
/**
 * Stryker Mutation Testing configuration (Sprint-469).
 *
 * Mutation testing injects small behavioural changes (flip <, swap +/-)
 * into the SDK source and re-runs the test suite. If no test fails on a
 * mutation, that's a "survived mutant" — a blind spot in the tests.
 *
 * CI threshold: 80% mutation score (high/break), 60% (low/break).
 *
 * Run: `pnpm mutation`
 * HTML report: reports/mutation/mutation.html
 *
 * @type {Partial<import('@stryker-mutator/api/core').StrykerOptions>}
 */
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  reporters: ["html", "clear-text", "progress"],
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/index.ts", // re-export files only
  ],
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: ".stryker-tmp/stryker-incremental.json",
  // ignoreStatic: skip mutants in module-level code (class fields, default exports).
  // These are "static" mutants — tested only during module load, not per test.
  // Without this flag: ~7% of mutants (388/5180) consume 94% of runtime.
  // Enable with `--force` for a full baseline; keep disabled for CI speed.
  ignoreStatic: true,
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },
  timeoutMS: 30_000,
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  disableTypeChecks: "{src,tests}/**/*.{ts,mjs}",
  // pnpm strict hoisting: explicit plugin paths ensure Stryker child processes
  // can resolve the vitest runner plugin without NODE_PATH tricks.
  plugins: [
    "@stryker-mutator/vitest-runner",
  ],
};
