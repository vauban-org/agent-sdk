/**
 * OODA Skill Registry — interface only (sprint-525:quick-1 foundation).
 *
 * Implementations land in sprint-525:quick-5. Skills are pure (or
 * side-effect-bearing) callable units invoked from inside OODA phase
 * functions. The `dryRunMocks` map lets tests + dry-run mode replace
 * any skill execution with a deterministic mock keyed by skill name.
 *
 * The SkillRegistry is intentionally untyped at the value level to keep
 * the SDK barrel compatible with arbitrary downstream skill libraries.
 * A typed lookup helper can be layered on top in 0.7.x.
 *
 * @public
 */

import type { LoggerPort } from "../../ports/logger.js";
import type { DbClient } from "../../tracking/agent-run-tracker.js";

/**
 * Secrets access surface handed to skills. Implementations MUST track every
 * lookup in `accessedSecrets` so callers can audit which secrets a skill
 * actually consumed (required for ADR-ECO-027 proof-grade tripartite and
 * future VPSF skill attestations).
 *
 * @public @since 1.2.0
 */
export interface SecretsAccessor {
  /**
   * Get a secret by name. Returns `defaultValue` if missing and provided;
   * otherwise throws when `defaultValue` is undefined and the secret is
   * not configured. Implementations MUST record the lookup in
   * `accessedSecrets` regardless of outcome.
   */
  get(name: string, defaultValue?: string): string;
  /** Whether a secret with this name is available. Counts as access. */
  has(name: string): boolean;
  /** Set of secret names the skill actually consulted during this invocation. */
  readonly accessedSecrets: ReadonlySet<string>;
}

/**
 * Error thrown by {@link InMemorySecretsAccessor} when a secret is requested
 * without a default value and is not configured.
 *
 * @public @since 1.2.0
 */
export class SecretNotFoundError extends Error {
  readonly secretName: string;
  constructor(secretName: string) {
    super(`secret '${secretName}' is not configured`);
    this.name = "SecretNotFoundError";
    this.secretName = secretName;
  }
}

/**
 * In-memory {@link SecretsAccessor} suitable for tests and ephemeral
 * runtimes. Production hosts can implement their own accessor backed by
 * Vault, SOPS, or k8s SealedSecrets while preserving the audit semantics.
 *
 * @public @since 1.2.0
 */
export class InMemorySecretsAccessor implements SecretsAccessor {
  private readonly store: ReadonlyMap<string, string>;
  private readonly accessed: Set<string> = new Set();

  constructor(secrets: Readonly<Record<string, string>> = {}) {
    this.store = new Map(Object.entries(secrets));
  }

  get(name: string, defaultValue?: string): string {
    this.accessed.add(name);
    const value = this.store.get(name);
    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    throw new SecretNotFoundError(name);
  }

  has(name: string): boolean {
    this.accessed.add(name);
    return this.store.has(name);
  }

  get accessedSecrets(): ReadonlySet<string> {
    return this.accessed;
  }
}

/**
 * Noop accessor — used as default for skills that declare no secrets.
 * Always returns `defaultValue` when provided, otherwise throws.
 *
 * @public @since 1.2.0
 */
export const NOOP_SECRETS: SecretsAccessor = new InMemorySecretsAccessor();

/**
 * Progress callback invoked by skills via `ctx.progress(value, message?)`.
 * `value` is clamped into `[0, 1]` by implementations.
 *
 * @public @since 1.2.0
 */
export type ProgressCallback = (value: number, message?: string) => void;

/**
 * Context handed to each skill invocation.
 *
 * `isReplay` MUST be honored by skills that have side-effects: when true,
 * the skill must short-circuit and emit no observable mutation (no LLM
 * call, no HTTP, no DB INSERT). This guarantees replay safety for the
 * OODA cycle log.
 *
 * Fields added in SDK v1.2.0 (executionId, secrets, progress,
 * elapsedSeconds, remainingSeconds) are OPTIONAL by design — existing
 * skills compile unchanged. New skills can opt in via the
 * {@link createSkillContext} factory.
 * @public
 */
export interface SkillContext {
  readonly isReplay: boolean;
  readonly dryRunMocks: Record<string, (input: unknown) => unknown>;
  readonly db: DbClient;
  readonly logger: LoggerPort;
  /** Unique invocation identifier. Optional for backwards compatibility. */
  readonly executionId?: string;
  /** Audit-trail-bearing secret access. Defaults to {@link NOOP_SECRETS}. */
  readonly secrets?: SecretsAccessor;
  /** Report execution progress in [0, 1]. Noop when absent. */
  readonly progress?: ProgressCallback;
  /** Seconds since invocation began. Returns 0 when not tracked. */
  readonly elapsedSeconds?: number;
  /** Seconds remaining until timeout. Returns +Infinity when not tracked. */
  readonly remainingSeconds?: number;
}

/**
 * Options for {@link createSkillContext}.
 *
 * @public @since 1.2.0
 */
export interface CreateSkillContextOptions {
  isReplay?: boolean;
  dryRunMocks?: Record<string, (input: unknown) => unknown>;
  db: DbClient;
  logger: LoggerPort;
  executionId?: string;
  secrets?: SecretsAccessor;
  progress?: ProgressCallback;
  /** Absolute timeout in seconds; used to compute remainingSeconds. Default: +Infinity. */
  timeoutSeconds?: number;
  /** Reference Date for elapsed/remaining computation. Default: new Date(). */
  startedAt?: Date;
}

/**
 * Build a {@link SkillContext} with sane defaults for the optional fields.
 * Useful for hosts that want a uniform context without writing the boilerplate.
 *
 * Time accessors are LIVE — `elapsedSeconds` and `remainingSeconds` are
 * recomputed on each property read, so a skill that loops can observe them
 * decreasing without rebuilding the context.
 *
 * @public @since 1.2.0
 */
export function createSkillContext(opts: CreateSkillContextOptions): SkillContext {
  const startedAt = opts.startedAt ?? new Date();
  const timeoutSeconds = opts.timeoutSeconds ?? Number.POSITIVE_INFINITY;
  const secrets = opts.secrets ?? NOOP_SECRETS;
  const progressFn = opts.progress ?? noopProgress;

  const ctx: SkillContext = {
    isReplay: opts.isReplay ?? false,
    dryRunMocks: opts.dryRunMocks ?? {},
    db: opts.db,
    logger: opts.logger,
    secrets,
    progress: (value, message) => {
      const clamped = clampProgress(value);
      progressFn(clamped, message);
    },
    get elapsedSeconds() {
      return Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
    },
    get remainingSeconds() {
      if (!Number.isFinite(timeoutSeconds)) return Number.POSITIVE_INFINITY;
      const elapsed = (Date.now() - startedAt.getTime()) / 1000;
      return Math.max(0, timeoutSeconds - elapsed);
    },
  };
  if (opts.executionId !== undefined) {
    Object.defineProperty(ctx, "executionId", {
      value: opts.executionId,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  return ctx;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const noopProgress: ProgressCallback = () => {};

/**
 * Skill — single named callable unit invoked from an OODA phase.
 *
 * `inputSchema` is typed `unknown` here to keep the registry value-type
 * homogeneous. Concrete skill libraries may use Zod (already a SDK dep)
 * to refine the input — but validation is enforced inside `execute`.
 * @public
 */
export interface Skill<I = unknown, O = unknown> {
  readonly name: string;
  /**
   * Runtime validator/parser for the skill input. Concrete skill libs
   * typically wire `z.ZodType<I>` here; the registry stays untyped.
   */
  readonly inputSchema: { parse: (raw: unknown) => I };
  execute(input: I, ctx: SkillContext): Promise<O>;
}

/**
 * SkillRegistry — name → skill map. Used by OODA phases to look up and
 * invoke skills without coupling to concrete implementations.
 * @public
 */
export type SkillRegistry = Record<string, Skill>;

/**
 * Empty registry — convenience for tests and minimal agents.
 * @public
 */
export const EMPTY_SKILL_REGISTRY: SkillRegistry = Object.freeze({});
