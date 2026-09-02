/**
 * Vitest config for POC-B tests only — not part of production test suite.
 * @poc-jetable
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/skills/poc-md-loader/**/*.test.ts"],
    globals: false,
  },
});
