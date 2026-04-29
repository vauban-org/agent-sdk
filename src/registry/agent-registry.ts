/**
 * AgentRegistry — plugin registration API for Vauban agent descriptors.
 *
 * Phase 1: register/get/list with validation.
 * Phase 2: discover() scans pnpm workspace packages for the
 * "@vauban/agent-plugin" keyword, dynamically imports each one,
 * and auto-registers its default export.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

// ─── Types ────────────────────────────────────────────────────────────────

/** Handler context injected into every agent run. */
export interface AgentContext {
  runId: string;
  traceId?: string;
}

/** Result returned by an agent handler. */
export interface AgentResult {
  output: string;
  stopReason: "complete" | "budget_exhausted" | "error" | string;
  inputTokens: number;
  outputTokens: number;
}

/** Handler function type. */
export type AgentHandler = (
  ctx: AgentContext,
  input: string,
) => Promise<AgentResult>;

/**
 * Descriptor for a registered agent. All fields are required except
 * `schedule` and `featureFlag` which are only relevant for cron agents.
 */
export interface AgentDescriptor {
  /** Stable slug (e.g. "market-radar"). Must be kebab-case, 1-63 chars. */
  id: string;
  /** Semver string (e.g. "0.2.0"). */
  version: string;
  /** Which loop primitive this agent uses. */
  loop: "minimal" | "sdk";
  /** Cron expression for scheduled agents (e.g. `0 * /6 * * *`). */
  schedule?: string;
  /** Env var name that gates this agent (e.g. "MARKETRADAR_CRON_ENABLED"). */
  featureFlag?: string;
  /** Monthly USD budget ceiling for this agent. */
  budget_monthly_usd: number;
  /** Human-readable description. */
  description: string;
  /** The async handler that runs the agent. */
  handler: AgentHandler;
}

// ─── Validation ───────────────────────────────────────────────────────────

const AGENT_ID_REGEX = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/;
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

function validateDescriptor(desc: AgentDescriptor): void {
  if (!AGENT_ID_REGEX.test(desc.id)) {
    throw new Error(
      `AgentRegistry: id "${desc.id}" must be kebab-case, 1-63 chars, starting with a letter`,
    );
  }
  if (!SEMVER_REGEX.test(desc.version)) {
    throw new Error(
      `AgentRegistry: version "${desc.version}" must be semver (e.g. "0.1.0")`,
    );
  }
  if (
    desc.budget_monthly_usd < 0 ||
    !Number.isFinite(desc.budget_monthly_usd)
  ) {
    throw new Error(
      `AgentRegistry: budget_monthly_usd for "${desc.id}" must be a non-negative finite number`,
    );
  }
  if (typeof desc.handler !== "function") {
    throw new Error(
      `AgentRegistry: handler for "${desc.id}" must be a function`,
    );
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDescriptor>();

  /**
   * Register an agent descriptor. Validates the descriptor and throws on
   * duplicate id or invalid fields.
   */
  register(desc: AgentDescriptor): void {
    validateDescriptor(desc);
    if (this.agents.has(desc.id)) {
      throw new Error(
        `AgentRegistry: agent "${desc.id}" is already registered`,
      );
    }
    this.agents.set(desc.id, { ...desc });
  }

  /** Get a registered agent by id. Returns undefined if not found. */
  get(id: string): AgentDescriptor | undefined {
    return this.agents.get(id);
  }

  /** List all registered agent descriptors. */
  list(): AgentDescriptor[] {
    return Array.from(this.agents.values());
  }

  /** Number of registered agents. */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Unregister an agent by id. Returns true if removed, false if not found.
   */
  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * Scan the pnpm workspace at `workspaceRoot` for packages whose
   * `package.json` `keywords` array includes `"@vauban/agent-plugin"`,
   * dynamically import each one, and register the default export
   * (an `AgentDescriptor`).
   *
   * Idempotent: if a plugin is already registered, skips it silently.
   * Malformed plugins (missing default export, non-descriptor shape)
   * are skipped with a warning — discover() never throws.
   *
   * @param workspaceRoot  Absolute path to the workspace root containing pnpm-workspace.yaml.
   * @returns The descriptors that were newly registered by this call.
   */
  async discover(workspaceRoot: string): Promise<AgentDescriptor[]> {
    const packageDirs = await resolveWorkspacePackageDirs(workspaceRoot);
    const discovered: AgentDescriptor[] = [];

    for (const dir of packageDirs) {
      const pkgJsonPath = path.join(dir, "package.json");
      let pkgJsonRaw: string;
      try {
        pkgJsonRaw = await fs.readFile(pkgJsonPath, "utf-8");
      } catch {
        continue;
      }

      let pkg: {
        name?: unknown;
        keywords?: unknown;
        main?: unknown;
        exports?: unknown;
      };
      try {
        pkg = JSON.parse(pkgJsonRaw);
      } catch {
        continue;
      }

      if (
        typeof pkg.name !== "string" ||
        !Array.isArray(pkg.keywords) ||
        !pkg.keywords.includes("@vauban/agent-plugin")
      ) {
        continue;
      }

      // Resolve the plugin's entry point. Prefer `exports["."]` (string
      // form), fall back to `main`, then `index.js`. Dynamic import via
      // file URL avoids bare-specifier resolution that may fail in test
      // sandboxes that do not have the plugin symlinked into the caller's
      // node_modules.
      const entryRel = resolvePackageEntry(pkg);
      const entryAbs = path.join(dir, entryRel);
      let imported: { default?: unknown };
      try {
        imported = (await import(pathToFileURL(entryAbs).href)) as {
          default?: unknown;
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agent-registry] failed to import plugin "${pkg.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const descriptor = imported.default;
      if (!isAgentDescriptorShape(descriptor)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agent-registry] plugin "${pkg.name}" has no default export AgentDescriptor — skipping`,
        );
        continue;
      }

      if (this.agents.has(descriptor.id)) {
        // Already registered (e.g. manual register() before discover()).
        continue;
      }

      try {
        this.register(descriptor);
        discovered.push(descriptor);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[agent-registry] plugin "${pkg.name}" rejected by register(): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return discovered;
  }
}

// ─── Helpers (unexported) ─────────────────────────────────────────────────

/**
 * Resolve the absolute directory of every package declared in the
 * root `pnpm-workspace.yaml` globs. Glob patterns supported:
 * literal path (`packages/foo`) and single-segment wildcard
 * (`packages/*`, `apps/agents/*`).
 */
async function resolveWorkspacePackageDirs(
  workspaceRoot: string,
): Promise<string[]> {
  const wsYamlPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
  let raw: string;
  try {
    raw = await fs.readFile(wsYamlPath, "utf-8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const wsCfg = parsed as { packages?: unknown };
  if (!Array.isArray(wsCfg.packages)) return [];

  const dirs: string[] = [];
  for (const pattern of wsCfg.packages) {
    if (typeof pattern !== "string") continue;
    if (pattern.endsWith("/*")) {
      const parent = path.join(workspaceRoot, pattern.slice(0, -2));
      let entries: string[];
      try {
        entries = await fs.readdir(parent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(parent, entry);
        try {
          const stat = await fs.stat(full);
          if (stat.isDirectory()) dirs.push(full);
        } catch {
          /* skip unreadable entries */
        }
      }
    } else {
      dirs.push(path.join(workspaceRoot, pattern));
    }
  }

  return dirs;
}

/**
 * Pick the entry-point path declared in a package.json, using the
 * precedence: exports["."] (string) > main > "index.js".
 */
function resolvePackageEntry(pkg: {
  main?: unknown;
  exports?: unknown;
}): string {
  if (typeof pkg.exports === "string") return pkg.exports;
  if (typeof pkg.exports === "object" && pkg.exports !== null) {
    const dot = (pkg.exports as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (typeof dot === "object" && dot !== null) {
      const candidate =
        (dot as Record<string, unknown>).default ??
        (dot as Record<string, unknown>).import;
      if (typeof candidate === "string") return candidate;
    }
  }
  if (typeof pkg.main === "string") return pkg.main;
  return "index.js";
}

/** Structural check: value is shaped like an AgentDescriptor. */
function isAgentDescriptorShape(v: unknown): v is AgentDescriptor {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.version === "string" &&
    (d.loop === "minimal" || d.loop === "sdk") &&
    typeof d.budget_monthly_usd === "number" &&
    typeof d.description === "string" &&
    typeof d.handler === "function"
  );
}

/** Default singleton registry for process-level use. */
export const agentRegistry = new AgentRegistry();
