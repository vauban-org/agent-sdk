/**
 * initSDK — SDK runtime initialization at agent boot.
 *
 * Promoted from forge/src/agents/shared/startup.ts (Vague 1.B.2).
 * Forge-specific coupling neutralized:
 * - CC_REGISTRY_URL hardcoded → parameterizable via `registryUrl` option
 * - CC_SERVICE_TOKEN env var → kept as env var (secret, cannot be in code)
 * - OTel collector URL → parameterizable
 *
 * @public @since 0.17.0
 */

import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { initVaubanSDK } from "../otel/ingest.js";
import type { AgentDescriptor, AgentRegistryPort } from "../ports/agent-registry.js";

// ─── InitSDKOptions ───────────────────────────────────────────────────────────

/**
 * Options for initSDK.
 *
 * @public
 */
/**
 * Optional self-registration options for the AgentRegistryPort.
 * When provided alongside a `descriptor`, `initSDK` calls
 * `registry.register(descriptor)` at boot (fire-and-forget, non-fatal).
 *
 * @public
 */
export interface RegistryOpts {
  /** Concrete AgentRegistryPort implementation (Memory or Postgres). */
  registry: AgentRegistryPort;
  /** Agent descriptor to register. */
  descriptor: AgentDescriptor;
}

export interface InitSDKOptions {
  /** Agent identifier (e.g. "forge-revenue"). */
  agentId: string;
  /** Agent semver version string. */
  agentVersion: string;
  /** Organization ID (e.g. "forge", "vauban", "cc"). */
  orgId: string;
  /** Human-readable agent name (default: agentId). */
  agentName?: string;
  /** Declared capabilities for the CC registry. */
  capabilities?: string[];
  /** Repository URL for the agent card. */
  repoUrl?: string;
  /**
   * Command Center registry URL for auto-registration.
   * When omitted, auto-registration is skipped.
   * Default env fallback: `CC_REGISTRY_URL` environment variable.
   */
  registryUrl?: string;
  /**
   * OTel collector endpoint.
   * Default: `OTEL_EXPORTER_OTLP_ENDPOINT` when set, else `http://localhost:4318`.
   */
  collectorUrl?: string;
  /** Enable console span exporter for local debugging. */
  debug?: boolean;
  /**
   * Optional AgentRegistryPort self-registration.
   * When provided, calls `registry.register(descriptor)` at boot.
   * Errors are swallowed and logged as warnings — never fatal.
   */
  registryOpts?: RegistryOpts;
}

// ─── initSDK ─────────────────────────────────────────────────────────────────

/**
 * Initialize OTel SDK + ports + agent registry at boot.
 *
 * Steps:
 * 1. Calls `initVaubanSDK` to set up OTel OTLP exporter + W3C propagator.
 * 2. Registers the agent in the CC registry (fire-and-forget, non-fatal).
 *
 * Returns the OTel BasicTracerProvider for introspection.
 * Registration errors are logged as warnings and never throw.
 *
 * @example
 * ```ts
 * initSDK({
 *   agentId: "forge-revenue",
 *   agentVersion: "1.0.0",
 *   orgId: "forge",
 *   capabilities: ["revenue-tracking", "gtm"],
 *   repoUrl: "https://github.com/vauban/forge",
 * });
 * ```
 *
 * @public
 */
export function initSDK(opts: InitSDKOptions): BasicTracerProvider {
  const registryUrl = opts.registryUrl ?? process.env.CC_REGISTRY_URL;
  const apiKey = process.env.VAUBAN_API_KEY ?? "";

  const provider = initVaubanSDK({
    apiKey,
    agentId: opts.agentId,
    agentVersion: opts.agentVersion,
    orgId: opts.orgId,
    agentName: opts.agentName ?? opts.agentId,
    capabilities: opts.capabilities ?? [],
    repoUrl: opts.repoUrl,
    collectorUrl: opts.collectorUrl,
    registryUrl,
    debug: opts.debug,
  });

  // Self-registration via AgentRegistryPort (fire-and-forget, non-fatal).
  if (opts.registryOpts !== undefined) {
    const { registry, descriptor } = opts.registryOpts;
    registry.register(descriptor).catch((err: unknown) => {
      // Non-fatal — agent still boots if registry is unavailable.
      console.warn("[initSDK] registry.register failed (non-fatal):", err);
    });
  }

  return provider;
}
