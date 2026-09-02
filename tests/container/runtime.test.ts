import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_ENV } from "../../src/container/protocol.js";
import {
  ContainerRuntime,
  type SandboxExecutor,
  type SandboxJob,
  type SandboxResult,
  type SpawnFn,
} from "../../src/container/runtime.js";

// ─── Fake child process for spawnFn injection ────────────────────────────────

class FakeStdio extends EventEmitter {
  write() {}
  end() {}
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdio();
  stdout = new FakeStdio();
  stderr = new FakeStdio();
}

function fakeSpawnEmittingProtocol(opts: {
  stdoutLines: string[];
  stderrLines?: string[];
  exitCode?: number;
  emitErrorAfter?: number; // ms; if set, emits AbortError after this delay
}): { spawn: SpawnFn; child: FakeChild } {
  const child = new FakeChild();
  const spawn: SpawnFn = vi.fn(() => {
    queueMicrotask(() => {
      for (const line of opts.stdoutLines) {
        child.stdout.emit("data", Buffer.from(`${line}\n`));
      }
      for (const line of opts.stderrLines ?? []) {
        child.stderr.emit("data", Buffer.from(`${line}\n`));
      }
      if (opts.emitErrorAfter !== undefined) {
        setTimeout(() => {
          const err = new Error("aborted") as NodeJS.ErrnoException;
          err.name = "AbortError";
          child.emit("error", err);
        }, opts.emitErrorAfter);
      } else {
        child.emit("close", opts.exitCode ?? 0);
      }
    });
    return child as unknown as ReturnType<SpawnFn>;
  });
  return { spawn, child };
}

// ─── Mock sandbox for container mode ─────────────────────────────────────────

function mockSandbox(impl: (job: SandboxJob) => SandboxResult): SandboxExecutor {
  return { run: vi.fn(async (job) => impl(job)) };
}

describe("ContainerRuntime.executeBinary", () => {
  it("passes input via VAUBAN_INPUT env and parses completed protocol result", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ['{"status":"completed","output":{"echo":"hi"}}'],
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/usr/bin/echo"], "echo-auto", {
      msg: "hi",
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ echo: "hi" });
    expect(result.automationName).toBe("echo-auto");
    expect(result.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(spawn).toHaveBeenCalledOnce();
    const [, , opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const passedEnv = opts.env as Record<string, string>;
    expect(passedEnv[PROTOCOL_ENV.AUTOMATION_NAME]).toBe("echo-auto");
    expect(JSON.parse(passedEnv[PROTOCOL_ENV.INPUT]!)).toEqual({ msg: "hi" });
    expect(passedEnv[PROTOCOL_ENV.TIMEOUT]).toBe("300");
  });

  it("returns failed status when protocol reports failure", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ['{"status":"failed","error":{"code":"BAD","message":"x"}}'],
      exitCode: 1, // protocol fail with non-zero exit — still a business failure
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/bin/false"], "x", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BAD");
  });

  it("surfaces CONTAINER_EXIT_ERROR when no protocol output and non-zero exit", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ["garbage"],
      stderrLines: ["something went wrong"],
      exitCode: 137,
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/bin/false"], "x", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTAINER_EXIT_ERROR");
    const details = result.error?.details as { stderr: string };
    expect(details.stderr).toContain("something went wrong");
  });

  it("surfaces INVALID_OUTPUT when exit=0 but no parseable protocol", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ["junk"],
      exitCode: 0,
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/bin/true"], "x", {});
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INVALID_OUTPUT");
  });

  it("captures stderr as logs", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ['{"status":"completed","output":null}'],
      stderrLines: ['{"level":"info","message":"hello","timestamp":"2026-01-01T00:00:00Z"}'],
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/bin/true"], "x", {});
    expect(result.logs.length).toBeGreaterThanOrEqual(1);
    expect(result.logs[0]?.message).toBe("hello");
  });

  it("respects caller-provided executionId", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: ['{"status":"completed","output":null}'],
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(["/bin/true"], "x", null, {
      executionId: "fixed-id-1",
    });
    expect(result.executionId).toBe("fixed-id-1");
  });

  it("throws when command is empty", async () => {
    const runtime = new ContainerRuntime();
    await expect(runtime.executeBinary([], "x", {})).rejects.toThrow(/non-empty array/);
  });

  it("returns timeout status when subprocess aborts via signal", async () => {
    const { spawn } = fakeSpawnEmittingProtocol({
      stdoutLines: [],
      emitErrorAfter: 5,
    });
    const runtime = new ContainerRuntime({ spawnFn: spawn });
    const result = await runtime.executeBinary(
      ["/bin/sleep"],
      "slow",
      {},
      {
        timeoutSeconds: 1,
      },
    );
    expect(result.status).toBe("timeout");
    expect(result.error?.code).toBe("TIMEOUT");
  });
});

describe("ContainerRuntime.executeContainer", () => {
  it("delegates to injected SandboxExecutor with protocol env", async () => {
    let capturedJob: SandboxJob | undefined;
    const sandbox = mockSandbox((job) => {
      capturedJob = job;
      return {
        exitCode: 0,
        stdout: '{"status":"completed","output":{"ran":true}}',
        stderr: "",
        timedOut: false,
        durationMs: 12,
      };
    });
    const runtime = new ContainerRuntime({ sandbox });
    const result = await runtime.executeContainer<{ ran: boolean }>(
      "ghcr.io/example/echo:1",
      "echo-c",
      { msg: "hi" },
      { networkMode: "none", memoryMb: 128 },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ ran: true });
    expect(capturedJob).toBeDefined();
    expect(capturedJob!.image).toBe("ghcr.io/example/echo:1");
    expect(capturedJob!.networkMode).toBe("none");
    expect(capturedJob!.memoryMb).toBe(128);
    const env = capturedJob!.env as Record<string, string>;
    expect(env[PROTOCOL_ENV.AUTOMATION_NAME]).toBe("echo-c");
    expect(JSON.parse(env[PROTOCOL_ENV.INPUT]!)).toEqual({ msg: "hi" });
  });

  it("converts sandbox timedOut to ExecutionResult timeout status", async () => {
    const sandbox = mockSandbox(() => ({
      exitCode: 137,
      stdout: "",
      stderr: "",
      timedOut: true,
      durationMs: 1000,
    }));
    const runtime = new ContainerRuntime({ sandbox });
    const result = await runtime.executeContainer("img", "auto", {}, {});
    expect(result.status).toBe("timeout");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.durationMs).toBe(1000);
  });

  it("throws when no sandbox is injected", async () => {
    const runtime = new ContainerRuntime();
    await expect(runtime.executeContainer("img", "auto", {})).rejects.toThrow(
      /no SandboxExecutor injected/,
    );
  });

  it("defaults networkMode to 'none' and readOnlyRoot to true", async () => {
    let capturedJob: SandboxJob | undefined;
    const sandbox = mockSandbox((job) => {
      capturedJob = job;
      return {
        exitCode: 0,
        stdout: '{"status":"completed","output":null}',
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    });
    const runtime = new ContainerRuntime({ sandbox });
    await runtime.executeContainer("img", "auto", {});
    expect(capturedJob!.networkMode).toBe("none");
    expect(capturedJob!.readOnlyRoot).toBe(true);
  });
});
