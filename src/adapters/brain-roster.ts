/**
 * BrainRoster ; the set of Brains one agent can reach, and the rules for
 * reading and writing across them.
 *
 * WHY (founder, 2026-08-29): "elle est censee etre connectee a plusieurs
 * brains, le brain vauban et le brain Fabien perso a minima". Until now every
 * host resolved a single scalar brain id and handed it to one HTTP client, so
 * an agent could reach exactly one Brain, for reads and writes alike.
 *
 * This lives in the SDK, next to {@link ../ports/brain.js | BrainPort}, and
 * not in a host package: the roster is what {@link ./multi-brain.js} composes
 * into a real `BrainPort`, so every existing `BrainPort` consumer (the Forge
 * agent fleet, Bastion, the OODA factory, the preste CLI) inherits multi-Brain
 * reach without changing a call site. A roster that only one host can see is a
 * feature of that host; a roster behind the port is a capability of the base.
 *
 * ── Reads fan out, writes do not ───────────────────────────────────────────
 *
 * These two are asymmetric on purpose, and the asymmetry is the whole design.
 *
 * READING from the wrong Brain costs nothing: you get an answer that turns out
 * to be from somewhere else, and the result says which. So a query goes to
 * every configured Brain and the results carry their origin.
 *
 * WRITING to the wrong Brain is not recoverable in the same way. A personal
 * note filed into a shared organisational memory is a disclosure, and nobody
 * finds out by reading the call's return value. So a write has exactly ONE
 * default destination, and targeting another requires naming it. An unknown
 * name is REFUSED rather than silently falling back to the default: falling
 * back would turn a typo into a misfiled secret, which is precisely the class
 * of failure this module exists to prevent.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 *
 * The primary Brain keeps the variables each host already uses, unchanged, so
 * every existing deployment keeps working with no edit:
 *   `<PREFIX>_ID` / `<PREFIX>_API_KEY` / `<PREFIX>_TOKEN` / `<PREFIX>_URL`
 * where `<PREFIX>` defaults to `BRAIN` then `PRESTE_BRAIN`, first defined
 * wins, per field. (`BRAIN_*` is the SDK/Forge deployment contract documented
 * on `createBrainPortFromEnv`; `PRESTE_BRAIN_*` is the preste CLI's.)
 *
 * Additional Brains are declared by name, one group each:
 *   `<PREFIX>_<NAME>_ID` / `<PREFIX>_<NAME>_API_KEY`
 *   `<PREFIX>_<NAME>_TOKEN` / `<PREFIX>_<NAME>_URL`   (both optional)
 *
 * Named variables rather than one composite variable, deliberately: a
 * credential is a secret, and packing several into a single string invites the
 * kind of parsing that goes wrong quietly. A group with no credential is
 * DROPPED with a reason, never registered with an empty one -- a Brain that
 * answers 401 on every call looks configured and is not, which is the harder
 * failure to see. That is not hypothetical: an agent's episodic memory died in
 * production on 2026-08-29 behind a port built with a URL and no credential.
 *
 * @public
 */

/** One reachable Brain. Invariant: `token` or `apiKey` is a non-empty string. */
export interface BrainTarget {
  /** How the founder and the model refer to it: "personal", "vauban". */
  readonly name: string;
  /**
   * Brain instance UUID. May be `""` for the PRIMARY only: an HTTP client can
   * discover the default Brain behind a credential, and production sometimes
   * supplies the credential alone. See {@link resolveBrainRoster}.
   */
  readonly brainId: string;
  readonly baseUrl: string;
  /** OAuth 2.1 bearer token. Takes precedence over `apiKey`, as in the adapter. */
  readonly token?: string;
  /** `x-api-key` credential. */
  readonly apiKey?: string;
  /** The single default write destination. Exactly one target carries it. */
  readonly isPrimary: boolean;
}

/** @public */
export interface BrainRoster {
  readonly targets: readonly BrainTarget[];
  /**
   * Reasons a declared Brain was dropped. Never silent: a host is expected to
   * surface these, because "configured but unusable" is invisible otherwise.
   */
  readonly skipped: readonly string[];
}

/** @public */
export interface BrainRosterOptions {
  /**
   * Environment variable prefixes, most significant first. Each field is
   * resolved independently across the list, first defined wins, so a host can
   * layer its own prefix over the shared `BRAIN_*` contract.
   */
  readonly envPrefixes?: readonly string[];
  /** Name given to the primary target. Hosts pick what the founder would say. */
  readonly primaryName?: string;
  /** Used when no `<PREFIX>_URL` and no `primaryFallback.baseUrl` is set. */
  readonly defaultBaseUrl?: string;
  /**
   * Non-environment source for the PRIMARY only (a host config file). Applied
   * per field, after every prefix, so an env id still composes with a config
   * credential exactly as the pre-roster code did.
   */
  readonly primaryFallback?: {
    readonly brainId?: string | undefined;
    readonly apiKey?: string | undefined;
    readonly token?: string | undefined;
    readonly baseUrl?: string | undefined;
  };
}

const DEFAULT_PREFIXES = ["BRAIN", "PRESTE_BRAIN"] as const;
const DEFAULT_BASE_URL = "https://brain.api.vauban.tech";

type Env = Record<string, string | undefined>;

/** First non-empty value across `prefixes`, for a shared suffix. */
function firstDefined(env: Env, prefixes: readonly string[], suffix: string): string | undefined {
  for (const p of prefixes) {
    const v = env[`${p}_${suffix}`];
    if (v) return v;
  }
  return undefined;
}

/**
 * `BRAIN_VAUBAN_ID` -> `vauban` for prefix `BRAIN`. Returns null for anything
 * that is not a `<PREFIX>_<NAME>_ID` group.
 *
 * The `_ID$` anchor is load-bearing: it is the reason `<PREFIX>_API_KEY` (the
 * primary's own credential) can never be read as a Brain named "api". Do not
 * relax it into a generic `_ID` search.
 */
function namedBrainFrom(varName: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    const m = new RegExp(`^${p}_([A-Z0-9]+(?:_[A-Z0-9]+)*)_ID$`).exec(varName);
    if (m?.[1]) return m[1].toLowerCase().replace(/_/g, "-");
  }
  return null;
}

/**
 * Read the roster from an environment map.
 *
 * Pure with respect to `env`: the caller passes it, so this is testable
 * without mutating `process.env`.
 *
 * @public
 */
export function resolveBrainRoster(env: Env, opts: BrainRosterOptions = {}): BrainRoster {
  const prefixes = opts.envPrefixes?.length ? opts.envPrefixes : DEFAULT_PREFIXES;
  const primaryName = opts.primaryName ?? "default";
  const fallback = opts.primaryFallback;
  const defaultUrl =
    firstDefined(env, prefixes, "URL") ??
    fallback?.baseUrl ??
    opts.defaultBaseUrl ??
    DEFAULT_BASE_URL;

  const targets: BrainTarget[] = [];
  const skipped: string[] = [];

  const primaryId = firstDefined(env, prefixes, "ID") ?? fallback?.brainId;
  const primaryKey = firstDefined(env, prefixes, "API_KEY") ?? fallback?.apiKey;
  const primaryToken = firstDefined(env, prefixes, "TOKEN") ?? fallback?.token;

  // THE PRIMARY NEEDS ONLY A CREDENTIAL, and that asymmetry with the named
  // Brains below is not an oversight. An HTTP client can resolve the default
  // Brain behind a credential on its own (preste's `discoverBrainId()`), so a
  // deployment that supplies a credential and no id has always worked and must
  // keep working -- a first version of this module required both and silently
  // turned every such deployment into "no primary Brain configured".
  // Discovery only applies to the DEFAULT Brain, so a NAMED Brain with no id
  // has nothing to discover and is still dropped, below.
  if (primaryToken || primaryKey) {
    targets.push({
      name: primaryName,
      brainId: primaryId ?? "",
      baseUrl: defaultUrl,
      ...(primaryToken ? { token: primaryToken } : {}),
      ...(primaryKey ? { apiKey: primaryKey } : {}),
      isPrimary: true,
    });
  } else if (primaryId) {
    skipped.push(
      `primary Brain has an id but no credential ; set ${prefixes[0]}_API_KEY or ${prefixes[0]}_TOKEN ; dropped`,
    );
  }

  // Sorted so the roster (and therefore every fan-out and every error message)
  // is deterministic whatever order the host's environment enumerates in.
  for (const varName of Object.keys(env).sort()) {
    const name = namedBrainFrom(varName, prefixes);
    if (!name) continue;
    const id = env[varName];
    if (!id) continue;
    const base = varName.slice(0, -"_ID".length);
    const key = env[`${base}_API_KEY`];
    const token = env[`${base}_TOKEN`];
    if (!key && !token) {
      // Not registered with an empty credential: see the module doc. A 401 on
      // every call is worse than an absence, because it looks configured.
      skipped.push(
        `Brain "${name}" has ${varName} but no ${base}_API_KEY or ${base}_TOKEN ; dropped`,
      );
      continue;
    }
    if (targets.some((t) => t.name === name)) {
      skipped.push(`Brain "${name}" declared twice ; kept the first`);
      continue;
    }
    targets.push({
      name,
      brainId: id,
      baseUrl: env[`${base}_URL`] ?? defaultUrl,
      ...(token ? { token } : {}),
      ...(key ? { apiKey: key } : {}),
      isPrimary: false,
    });
  }

  return { targets, skipped };
}

/**
 * The single write destination, or null when no Brain is fully configured.
 * @public
 */
export function primaryTarget(roster: BrainRoster): BrainTarget | null {
  return roster.targets.find((t) => t.isPrimary) ?? null;
}

/** @public */
export type WriteTargetResolution =
  | { readonly ok: true; readonly target: BrainTarget }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a write destination by name.
 *
 * `undefined` means "the default", which is the primary. A NAME that matches
 * nothing is an error, never the default: silently writing a note meant for
 * one Brain into another is the failure this whole module is shaped around,
 * and the caller's return value would say "saved".
 *
 * Returns a result rather than throwing, so a tool surface can hand the model
 * a correctable error (it lists the names that DO exist) while a port surface
 * turns the same result into a thrown `MemoryValidationError`.
 *
 * @public
 */
export function resolveWriteTarget(
  roster: BrainRoster,
  name: string | undefined,
  opts: { readonly envPrefixes?: readonly string[] } = {},
): WriteTargetResolution {
  const prefix = opts.envPrefixes?.[0] ?? DEFAULT_PREFIXES[0];
  if (name === undefined) {
    const p = primaryTarget(roster);
    return p
      ? { ok: true, target: p }
      : {
          ok: false,
          error: `no primary Brain configured (${prefix}_ID / ${prefix}_API_KEY)`,
        };
  }
  const wanted = name.trim().toLowerCase();
  const found = roster.targets.find((t) => t.name === wanted);
  if (!found) {
    const known = roster.targets.map((t) => t.name).join(", ") || "none";
    return { ok: false, error: `unknown Brain "${name}" ; configured: ${known}` };
  }
  return { ok: true, target: found };
}
