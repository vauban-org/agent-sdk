/**
 * Tests for `SqlitePersistencePort` (P7 — SDK-side SHIPPED default).
 *
 * The SQLite impl is the SDK-shipped default that closes R2
 * (token-replay-after-restart). Every assertion here is a piece of the
 * security contract Bastion verifier rolls out on top of.
 *
 * Covers :
 *   - File creation under a writable tmp dir
 *   - Save + load revocations round-trip
 *   - Save + load events with sinceSeq filter
 *   - getMaxSeq tracking
 *   - clearAll empties both tables
 *   - Concurrent saveRevocation calls do not deadlock (sync better-sqlite3
 *     wrapped behind async port API)
 *   - File-not-existing path : initial load returns empty arrays, schema
 *     is created on first write
 *   - Restart simulation : write revocations, close, re-open with a fresh
 *     handle, loadRevocations returns the same revocations (the R2 closure
 *     property)
 *   - Idempotent inserts (INSERT OR IGNORE on jti + seq)
 *   - close() makes subsequent operations throw
 *   - sqlitePathForSession honors PRESTE_HOME
 *   - Real-ESM regression : `require("better-sqlite3")` must not throw
 *     `ReferenceError: require is not defined` under Node's actual ESM
 *     loader (vitest's own transform shims `require` and would mask this ;
 *     see the dedicated describe block below for why a subprocess is used)
 *   - Mocked-resolution regression : the constructor's error message when
 *     better-sqlite3 genuinely cannot be resolved
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEventSeq, makeEvent } from "../../src/remote/events.js";
import {
  SqlitePersistencePort,
  sqlitePathForSession,
} from "../../src/remote/persistence-sqlite.js";

const SRC_PERSISTENCE_SQLITE_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/remote/persistence-sqlite.ts",
);

describe("SqlitePersistencePort (SDK)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdk-sqlite-persist-"));
    dbPath = join(tmpDir, "test.db");
    __resetEventSeq();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the parent directory lazily for nested paths", async () => {
    const nested = join(tmpDir, "a", "b", "session.db");
    const p = new SqlitePersistencePort({ dbPath: nested });
    expect(p.isClosed).toBe(false);
    expect(existsSync(nested)).toBe(true);
    await p.close();
  });

  it("returns empty arrays on a fresh DB before any write", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    expect(await p.loadEvents()).toEqual([]);
    expect(await p.loadRevocations()).toEqual([]);
    expect(await p.getMaxSeq()).toBe(0);
    await p.close();
  });

  it("round-trips revocations (save + load)", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await p.saveRevocation("jti-1");
    await p.saveRevocation("jti-2");
    await p.saveRevocation("jti-3");
    const revs = (await p.loadRevocations()).sort();
    expect(revs).toEqual(["jti-1", "jti-2", "jti-3"]);
    await p.close();
  });

  it("round-trips events with seq ordering preserved", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    const e1 = makeEvent("run.start", { runId: "r", agentId: "a" });
    const e2 = makeEvent("run.step", { stepIndex: 0, costUsd: 0.01 });
    const e3 = makeEvent("run.step", { stepIndex: 1, costUsd: 0.02 });
    // Save out of order ; loadEvents must return them ordered by seq.
    await p.saveEvent(e3);
    await p.saveEvent(e1);
    await p.saveEvent(e2);
    const all = await p.loadEvents();
    expect(all.map((e) => e.seq)).toEqual([e1.seq, e2.seq, e3.seq]);
    expect(await p.getMaxSeq()).toBe(e3.seq);
    await p.close();
  });

  it("loadEvents respects the sinceSeq cutoff strictly", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    const a = makeEvent("run.start", { runId: "r", agentId: "a" });
    const b = makeEvent("run.step", { stepIndex: 0, costUsd: 0 });
    const c = makeEvent("run.step", { stepIndex: 1, costUsd: 0 });
    await p.saveEvent(a);
    await p.saveEvent(b);
    await p.saveEvent(c);

    const after = await p.loadEvents(b.seq);
    expect(after.map((e) => e.seq)).toEqual([c.seq]);

    const all = await p.loadEvents();
    expect(all).toHaveLength(3);
    await p.close();
  });

  it("clearAll wipes events AND revocations AND resets maxSeq", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await p.saveEvent(makeEvent("run.start", { runId: "r", agentId: "a" }));
    await p.saveRevocation("jti");
    await p.clearAll();
    expect(await p.loadEvents()).toEqual([]);
    expect(await p.loadRevocations()).toEqual([]);
    expect(await p.getMaxSeq()).toBe(0);
    await p.close();
  });

  it("idempotent saveRevocation does not raise on duplicate jti", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await p.saveRevocation("dup");
    await p.saveRevocation("dup");
    await p.saveRevocation("dup");
    expect(await p.loadRevocations()).toEqual(["dup"]);
    await p.close();
  });

  it("idempotent saveEvent on identical seq", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    const e = makeEvent("run.start", { runId: "r", agentId: "a" });
    await p.saveEvent(e);
    await p.saveEvent(e);
    await p.saveEvent(e);
    const all = await p.loadEvents();
    expect(all).toHaveLength(1);
    await p.close();
  });

  it("concurrent saveRevocation calls do not deadlock", async () => {
    // better-sqlite3 is synchronous ; the async port wrapping must not
    // introduce a deadlock under fan-out. Promise.all fans 50 writes ;
    // they must all settle, no timeout, no deadlock.
    const p = new SqlitePersistencePort({ dbPath });
    const jtis = Array.from({ length: 50 }, (_, i) => `jti-concurrent-${i}`);
    await Promise.all(jtis.map((jti) => p.saveRevocation(jti)));
    const loaded = (await p.loadRevocations()).sort();
    expect(loaded).toHaveLength(50);
    expect(loaded).toContain("jti-concurrent-0");
    expect(loaded).toContain("jti-concurrent-49");
    await p.close();
  });

  // The CRITICAL test that validates R2 closure (token-replay-after-restart).
  it("revocations survive close + reopen (R2 closure)", async () => {
    const p1 = new SqlitePersistencePort({ dbPath });
    await p1.saveRevocation("jti-attacker-replay");
    await p1.saveRevocation("jti-other");
    await p1.saveRevocation("jti-third");
    await p1.close();

    // Simulate process restart — fresh handle on the same db path.
    const p2 = new SqlitePersistencePort({ dbPath });
    const revs = (await p2.loadRevocations()).sort();
    expect(revs).toEqual(["jti-attacker-replay", "jti-other", "jti-third"]);
    await p2.close();
  });

  it("events survive close + reopen with correct ordering", async () => {
    const p1 = new SqlitePersistencePort({ dbPath });
    const e1 = makeEvent("run.start", { runId: "r", agentId: "a" });
    const e2 = makeEvent("run.step", { stepIndex: 0, costUsd: 0 });
    await p1.saveEvent(e1);
    await p1.saveEvent(e2);
    await p1.close();

    const p2 = new SqlitePersistencePort({ dbPath });
    const all = await p2.loadEvents();
    expect(all.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(await p2.getMaxSeq()).toBe(e2.seq);
    await p2.close();
  });

  it("rejects an empty jti up front", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await expect(p.saveRevocation("")).rejects.toThrow(/empty jti/);
    await p.close();
  });

  it("close() makes subsequent operations throw", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await p.saveRevocation("jti");
    await p.close();
    expect(p.isClosed).toBe(true);
    await expect(p.saveRevocation("x")).rejects.toThrow(/closed/);
    await expect(p.loadRevocations()).rejects.toThrow(/closed/);
    await expect(p.getMaxSeq()).rejects.toThrow(/closed/);
  });

  it("close() is idempotent", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    await p.close();
    await expect(p.close()).resolves.toBeUndefined();
  });

  it("preserves the full SessionEvent envelope through the JSON blob", async () => {
    const p = new SqlitePersistencePort({ dbPath });
    const e = {
      ...makeEvent("run.start", { runId: "r", agentId: "a" }),
      sig: "deadbeef",
    };
    await p.saveEvent(e);
    const reloaded = (await p.loadEvents())[0];
    expect(reloaded).toEqual(e);
    await p.close();
  });

  it("requires a dbPath in the constructor", () => {
    expect(() => new SqlitePersistencePort({ dbPath: "" })).toThrow(/dbPath is required/);
  });
});

describe("sqlitePathForSession", () => {
  it("honors PRESTE_HOME when set", () => {
    const prev = process.env.PRESTE_HOME;
    process.env.PRESTE_HOME = "/tmp/sdk-test-home";
    try {
      expect(sqlitePathForSession("abc")).toBe("/tmp/sdk-test-home/remote/abc.db");
    } finally {
      if (prev === undefined) delete process.env.PRESTE_HOME;
      else process.env.PRESTE_HOME = prev;
    }
  });

  it("falls back to $HOME/.preste when PRESTE_HOME is unset", () => {
    const prev = process.env.PRESTE_HOME;
    delete process.env.PRESTE_HOME;
    try {
      const home = process.env.HOME ?? "/root";
      expect(sqlitePathForSession("xyz")).toBe(`${home}/.preste/remote/xyz.db`);
    } finally {
      if (prev !== undefined) process.env.PRESTE_HOME = prev;
    }
  });

  it("baseDir argument overrides PRESTE_HOME and $HOME/.preste entirely", () => {
    const prev = process.env.PRESTE_HOME;
    process.env.PRESTE_HOME = "/tmp/sdk-test-home";
    try {
      expect(sqlitePathForSession("abc", "/custom/root")).toBe("/custom/root/remote/abc.db");
    } finally {
      if (prev === undefined) delete process.env.PRESTE_HOME;
      else process.env.PRESTE_HOME = prev;
    }
  });
});

describe("loadBetterSqlite3 ; real Node ESM require regression", () => {
  const nodeMajor = Number(process.version.slice(1).split(".")[0]);

  // vitest/vite-node transforms every module (test AND source) through its
  // own SSR pipeline, which shims a `require` global for CJS interop ; a
  // plain `new SqlitePersistencePort(...)` call in THIS test file would
  // therefore pass even with the bug (bare `require("better-sqlite3")`
  // throws `ReferenceError: require is not defined` only under the real
  // Node ESM loader, i.e. the actual `preste` CLI binary in production).
  // `--experimental-strip-types` runs the .ts source unmodified through
  // real Node ESM, which is the only way this class of bug is observable
  // in an automated test (same reasoning that led the attestation-store fix,
  // commit d579d549, to be validated by a real two-process smoke script
  // rather than a vitest assertion).
  it.skipIf(nodeMajor < 22)(
    "constructs successfully via createRequire under the real Node ESM loader",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "sdk-sqlite-esm-probe-"));
      const dbPath = join(tmpDir, "probe.db");
      try {
        const script = [
          `import { SqlitePersistencePort } from ${JSON.stringify(SRC_PERSISTENCE_SQLITE_TS)};`,
          `const p = new SqlitePersistencePort({ dbPath: ${JSON.stringify(dbPath)} });`,
          "await p.close();",
          `process.stdout.write("ESM-CONSTRUCT-OK");`,
        ].join("\n");
        const out = execFileSync(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(out).toContain("ESM-CONSTRUCT-OK");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

describe("loadBetterSqlite3 ; mocked resolution failure", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("throws the install-instructions error when better-sqlite3 cannot be resolved", async () => {
    vi.resetModules();
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return {
        ...actual,
        createRequire: () => {
          return (id: string) => {
            if (id === "better-sqlite3") {
              const err = new Error("Cannot find module 'better-sqlite3'") as NodeJS.ErrnoException;
              err.code = "MODULE_NOT_FOUND";
              throw err;
            }
            throw new Error(`unexpected require in mocked test: ${id}`);
          };
        },
      };
    });
    const { SqlitePersistencePort: MockedPort } = await import(
      "../../src/remote/persistence-sqlite.js"
    );
    expect(() => new MockedPort({ dbPath: "/tmp/unused.db" })).toThrow(
      /requires 'better-sqlite3' to be installed as a peerDependency/,
    );
  });

  it("does not warn and constructs silently when better-sqlite3 resolves normally", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "sdk-sqlite-silent-"));
    const dbPath = join(tmpDir, "silent.db");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const p = new SqlitePersistencePort({ dbPath });
      expect(p.isClosed).toBe(false);
      await p.close();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
