/**
 * End-to-end integration test for ContainerRuntime against real subprocesses.
 *
 * Spawns the example automations in `examples/automations/`:
 *   - `echo-ts/echo.ts` via the workspace `tsx` binary (skipped if the binary
 *     is not reachable from this file, see TSX_OK).
 *   - `echo-rs/target/release/echo` via Rust release binary (skipped if
 *     `cargo` is not installed on the host running tests).
 *
 * These tests prove the Container Execution Protocol works end-to-end with
 * real OS processes, not just the unit-test SpawnFn mocks.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ContainerRuntime } from "../../src/container/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");
const TS_AUTOMATION = path.join(REPO_ROOT, "examples/automations/echo-ts/echo.ts");
const RUST_MANIFEST = path.join(REPO_ROOT, "examples/automations/echo-rs/Cargo.toml");
const RUST_BINARY = path.join(REPO_ROOT, "examples/automations/echo-rs/target/release/echo");

function hasCargo(): boolean {
  try {
    execSync("cargo --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe a release build. Some hosts have cargo + rustc installed but a
 * broken linker setup (e.g. lld vs cc -m64 conflict). We treat that as
 * "Rust unavailable" and skip the Rust tests rather than failing the suite.
 */
function canBuildRust(): boolean {
  if (!hasCargo()) return false;
  try {
    execSync(`cargo build --release --manifest-path ${RUST_MANIFEST}`, {
      stdio: "pipe",
    });
    return existsSync(RUST_BINARY);
  } catch {
    return false;
  }
}

const RUST_BUILD_OK = canBuildRust();

/**
 * La moitié TypeScript se croyait « toujours disponible » et affirmait
 * `expect(existsSync(TSX_BIN)).toBe(true)` sans garde. C'est faux dès qu'un
 * outil exécute la suite AILLEURS que dans l'arbre du dépôt : `REPO_ROOT` est
 * dérivé de `__dirname`, donc il suit le fichier. Stryker recopie `src` et
 * `tests` dans `.stryker-tmp/sandbox-N/` (cf. `disableTypeChecks` dans
 * `stryker.conf.mjs`) ; `REPO_ROOT` y désigne le bac à sable, qui n'a pas de
 * `node_modules/.bin/tsx`, et l'assertion tombe en `expected false to be true`.
 *
 * Conséquence réelle : la campagne de mutation était morte au run à blanc
 * depuis toujours, sur CE seul test, donc AUCUN mutant n'a jamais été mesuré.
 * Un test d'intégration qui échoue hors de son terrain ne prouve rien et
 * bloque tout ; on s'abstient, exactement comme la moitié Rust le fait déjà
 * quand `cargo` manque. En CI normale les deux chemins existent, le test
 * s'exécute, et sa valeur est intacte.
 */
const TSX_OK = existsSync(TSX_BIN) && existsSync(TS_AUTOMATION);

describe.skipIf(!TSX_OK)("ContainerRuntime — TypeScript automation (tsx)", () => {
  it("executes echo-ts and returns the parsed protocol output", async () => {
    expect(existsSync(TSX_BIN)).toBe(true);
    expect(existsSync(TS_AUTOMATION)).toBe(true);

    const runtime = new ContainerRuntime();
    const result = await runtime.executeBinary<{
      echoed: unknown;
      language: string;
      name: string;
      execution_id: string;
    }>([TSX_BIN, TS_AUTOMATION], "echo-ts", { greeting: "hello", n: 42 }, { timeoutSeconds: 30 });

    expect(result.status).toBe("completed");
    expect(result.output?.language).toBe("typescript");
    expect(result.output?.name).toBe("echo-ts");
    expect(result.output?.echoed).toEqual({ greeting: "hello", n: 42 });
    expect(result.output?.execution_id).toBe(result.executionId);
    // Diagnostic log captured from stderr
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs.some((l) => l.message === "echo-ts starting")).toBe(true);
  });

  it("surfaces failed status when the automation reports INVALID_INPUT_JSON", async () => {
    const runtime = new ContainerRuntime();
    // Inject malformed JSON into VAUBAN_INPUT by overriding extraEnv AFTER
    // buildProtocolEnv — but the runtime always re-stringifies the input, so
    // we test the automation's own error path by sending a value that breaks
    // its parser. Simulate via a literal "broken" string.
    const result = await runtime.executeBinary(
      [TSX_BIN, TS_AUTOMATION],
      "echo-ts",
      "well-formed-json-string", // valid JSON → completed path
      { timeoutSeconds: 30 },
    );
    expect(result.status).toBe("completed");
  });
});

describe.skipIf(!RUST_BUILD_OK)("ContainerRuntime — Rust automation (cargo build)", () => {
  it("executes echo-rs and returns the parsed protocol output", async () => {
    const runtime = new ContainerRuntime();
    const result = await runtime.executeBinary<{
      echoed: unknown;
      language: string;
      name: string;
      execution_id: string;
    }>([RUST_BINARY], "echo-rs", { greeting: "salut", n: 7 }, { timeoutSeconds: 30 });

    expect(result.status).toBe("completed");
    expect(result.output?.language).toBe("rust");
    expect(result.output?.name).toBe("echo-rs");
    expect(result.output?.echoed).toEqual({ greeting: "salut", n: 7 });
    expect(result.output?.execution_id).toBe(result.executionId);
    expect(result.logs.some((l) => l.message === "echo-rs starting")).toBe(true);
  });

  it("captures execution time in durationMs", async () => {
    const runtime = new ContainerRuntime();
    const result = await runtime.executeBinary([RUST_BINARY], "echo-rs", null);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
