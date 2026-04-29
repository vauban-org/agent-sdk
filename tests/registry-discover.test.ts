/**
 * registry-discover.test.ts — unit tests for AgentRegistry.discover()
 *
 * Creates a temporary workspace on disk, seeds it with a fake plugin
 * package that exports a valid AgentDescriptor, and verifies:
 *   1. discover() returns the registered descriptors
 *   2. Idempotent re-discover does not duplicate
 *   3. Malformed packages are skipped silently (no throw)
 *   4. Packages without the @vauban/agent-plugin keyword are ignored
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/registry/agent-registry.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vauban-agent-discover-"));
  await fs.writeFile(
    path.join(tmpRoot, "pnpm-workspace.yaml"),
    "packages:\n  - 'plugins/*'\n",
  );
  await fs.mkdir(path.join(tmpRoot, "plugins"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writePlugin(
  pkgName: string,
  opts: {
    keywords?: string[];
    descriptor?: Record<string, unknown> | null;
    noDefault?: boolean;
  },
): Promise<void> {
  const dir = path.join(tmpRoot, "plugins", pkgName.replace(/^@[^/]+\//, ""));
  await fs.mkdir(dir, { recursive: true });

  const pkg = {
    name: pkgName,
    version: "0.1.0",
    type: "module",
    main: "index.js",
    keywords: opts.keywords ?? [],
  };
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));

  if (opts.noDefault) {
    await fs.writeFile(path.join(dir, "index.js"), "export const x = 1;\n");
    return;
  }

  const descriptor = opts.descriptor ?? {
    id: pkgName.split("/").pop() ?? "test",
    version: "0.2.0",
    loop: "minimal",
    budget_monthly_usd: 1,
    description: `fixture for ${pkgName}`,
    handler: "REPLACE_ME",
  };

  // Emit JS that materialises the descriptor with a real function handler.
  const js =
    `const descriptor = ${JSON.stringify(descriptor)};\n` +
    `descriptor.handler = async () => ({ output: "", stopReason: "complete", inputTokens: 0, outputTokens: 0 });\n` +
    `export default descriptor;\n`;
  await fs.writeFile(path.join(dir, "index.js"), js);

  // Make the plugin importable by `import(pkg.name)` — symlink into a
  // node_modules folder at workspace root.
  const nmDir = path.join(tmpRoot, "node_modules");
  await fs.mkdir(nmDir, { recursive: true });
  const scoped = pkgName.startsWith("@");
  if (scoped) {
    const [scope, name] = pkgName.split("/");
    await fs.mkdir(path.join(nmDir, scope), { recursive: true });
    await fs.symlink(dir, path.join(nmDir, scope, name), "dir");
  } else {
    await fs.symlink(dir, path.join(nmDir, pkgName), "dir");
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("AgentRegistry.discover", () => {
  it("returns descriptors for plugins with the @vauban/agent-plugin keyword", async () => {
    await writePlugin("@fixture/agent-alpha", {
      keywords: ["@vauban/agent-plugin"],
      descriptor: {
        id: "alpha",
        version: "0.1.0",
        loop: "minimal",
        budget_monthly_usd: 1,
        description: "alpha fixture",
      },
    });
    await writePlugin("@fixture/agent-beta", {
      keywords: ["@vauban/agent-plugin"],
      descriptor: {
        id: "beta",
        version: "0.2.0",
        loop: "sdk",
        budget_monthly_usd: 2,
        description: "beta fixture",
      },
    });

    const reg = new AgentRegistry();
    const found = await reg.discover(tmpRoot);

    const ids = found.map((d) => d.id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
    expect(reg.size).toBe(2);
  });

  it("ignores packages without the @vauban/agent-plugin keyword", async () => {
    await writePlugin("@fixture/not-a-plugin", {
      keywords: ["random-tag"],
    });

    const reg = new AgentRegistry();
    const found = await reg.discover(tmpRoot);
    expect(found).toEqual([]);
    expect(reg.size).toBe(0);
  });

  it("is idempotent — re-discover does not duplicate", async () => {
    await writePlugin("@fixture/agent-gamma", {
      keywords: ["@vauban/agent-plugin"],
      descriptor: {
        id: "gamma",
        version: "0.1.0",
        loop: "minimal",
        budget_monthly_usd: 0,
        description: "gamma fixture",
      },
    });

    const reg = new AgentRegistry();
    const first = await reg.discover(tmpRoot);
    expect(first).toHaveLength(1);
    const second = await reg.discover(tmpRoot);
    expect(second).toHaveLength(0);
    expect(reg.size).toBe(1);
  });

  it("skips malformed plugins without throwing", async () => {
    await writePlugin("@fixture/bad-plugin", {
      keywords: ["@vauban/agent-plugin"],
      noDefault: true,
    });

    const reg = new AgentRegistry();
    await expect(reg.discover(tmpRoot)).resolves.toEqual([]);
    expect(reg.size).toBe(0);
  });

  it("returns [] when workspace yaml is missing", async () => {
    await fs.rm(path.join(tmpRoot, "pnpm-workspace.yaml"));
    const reg = new AgentRegistry();
    const found = await reg.discover(tmpRoot);
    expect(found).toEqual([]);
  });
});
