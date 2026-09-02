/**
 * src/verify/formal/solver.ts
 *
 * Sprint-587 — Z3 SMT solver wrapper.
 *
 * Strategy : avoid adding `z3-solver` as a hard npm dependency (heavy WASM
 * package, ~5MB) by spawning the `z3` binary as a subprocess and piping
 * SMT-LIB v2 source on stdin. If `z3` is not in PATH, the wrapper degrades
 * gracefully by returning `{ sat: null }` so callers can map that to the
 * UNKNOWN state.
 *
 * This keeps the SDK lean : consumers that want formal verification install
 * `z3` system-wide (apt / brew / scoop). Consumers that do not, get UNKNOWN
 * results and can route them according to their policy.
 *
 * @module verify/formal/solver
 */

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

/**
 * Options accepted by {@link checkSmt}.
 */
export interface SolverOptions {
  /** Wall-clock timeout in milliseconds. Defaults to 5000ms. */
  timeout_ms?: number;
  /** Optional path to the z3 binary (defaults to `z3` resolved via PATH). */
  z3_path?: string;
}

/**
 * Outcome of a single SMT-LIB check-sat invocation.
 *
 * `sat`     : `true`  → solver returned `sat` (formula is satisfiable, i.e.
 *                       a counterexample exists for a violation query)
 *             `false` → solver returned `unsat` (no counterexample, the
 *                       property holds)
 *             `null`  → solver returned `unknown`, timed out, was not
 *                       installed, or failed to run
 * `model`   : when `sat === true`, the textual SMT-LIB model string emitted
 *             by `(get-model)` — useful as a counterexample witness
 * `time_ms` : wall-clock time spent waiting on the solver subprocess
 * `reason`  : optional human-readable diagnostic for UNKNOWN / null outcomes
 */
export interface SmtCheckResult {
  sat: boolean | null;
  model?: string;
  time_ms: number;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run a single SMT-LIB v2 formula through Z3 and return the satisfiability
 * outcome.
 *
 * Convention : the caller frames the property as a NEGATION (i.e. asserts the
 * conjunction of preconditions AND the negation of the postcondition). Then :
 *   - `sat`   → counterexample found → property VIOLATED → UNSAFE
 *   - `unsat` → no counterexample exists → property HOLDS → SAFE
 *   - `unknown` / timeout / missing binary → UNKNOWN
 *
 * The function never throws : transport errors and missing binaries are
 * surfaced via `sat: null` with a `reason` string.
 */
export async function checkSmt(
  smtFormula: string,
  options: SolverOptions = {},
): Promise<SmtCheckResult> {
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const z3Path = options.z3_path ?? "z3";

  const start = performance.now();

  return new Promise<SmtCheckResult>((resolve) => {
    // biome-ignore lint/suspicious/noImplicitAnyLet: z3 child-process handle; assigned from spawn() in the try below (piped stdio guarantees non-null streams).
    let child;
    try {
      child = spawn(z3Path, ["-in", `-T:${Math.ceil(timeoutMs / 1000)}`], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        sat: null,
        time_ms: performance.now() - start,
        reason: `z3 spawn failed : ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (r: SmtCheckResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignored */
      }
      settle({
        sat: null,
        time_ms: performance.now() - start,
        reason: `z3 timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        sat: null,
        time_ms: performance.now() - start,
        reason: `z3 not available : ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const time_ms = performance.now() - start;
      // z3 exits 0 even on `unsat`; non-zero usually means parse error.
      const out = stdout.trim();
      const firstLine = out.split(/\r?\n/)[0]?.trim() ?? "";

      if (firstLine === "sat") {
        // Extract model block if present (everything after the first line).
        const modelStart = out.indexOf("\n");
        const model = modelStart >= 0 ? out.slice(modelStart + 1).trim() : undefined;
        settle({ sat: true, model: model || undefined, time_ms });
        return;
      }
      if (firstLine === "unsat") {
        settle({ sat: false, time_ms });
        return;
      }
      if (firstLine === "unknown") {
        settle({
          sat: null,
          time_ms,
          reason: "z3 returned unknown (likely timeout or undecidable fragment)",
        });
        return;
      }
      // Parse error or other failure : surface stderr.
      settle({
        sat: null,
        time_ms,
        reason: `z3 unexpected output (exit ${code}) : ${(stderr || out).slice(0, 200)}`,
      });
    });

    try {
      child.stdin.write(smtFormula);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      settle({
        sat: null,
        time_ms: performance.now() - start,
        reason: `z3 stdin write failed : ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

/**
 * Probe : check whether a usable `z3` binary is reachable.
 * Returns `true` if `z3 --version` exits 0 within 1s.
 *
 * Cached for the lifetime of the process — the binary's presence does not
 * change at runtime.
 */
let z3Available: boolean | undefined;

export async function isZ3Available(z3Path = "z3"): Promise<boolean> {
  if (z3Available !== undefined) return z3Available;
  z3Available = await new Promise<boolean>((resolve) => {
    // biome-ignore lint/suspicious/noImplicitAnyLet: z3 child-process handle; assigned from spawn() in the try below (piped stdio guarantees non-null streams).
    let child;
    try {
      child = spawn(z3Path, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignored */
      }
      resolve(false);
    }, 1000);
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
  return z3Available;
}

/**
 * Test-only helper to reset the cached availability probe.
 * @internal
 */
export function __resetZ3AvailabilityCache(): void {
  z3Available = undefined;
}
