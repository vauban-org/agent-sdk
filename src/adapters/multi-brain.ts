/**
 * MultiBrainPort ; a `BrainPort` over several Brains at once.
 *
 * This is an ADAPTER, not a utility beside the port, and that is the point.
 * Everything that already takes a `BrainPort` (the Forge agent fleet's
 * `deps.memory`, Bastion, the OODA factory, the preste CLI's brain tools)
 * gains multi-Brain reach without a single call-site change, because the
 * contract it satisfies is the one they already speak
 * (`../ports/brain.ts:855`). A helper that only one host imports is a feature
 * of that host; an implementation of the port is a capability of the base.
 *
 * ── The asymmetry, which is the design ─────────────────────────────────────
 *
 * READS FAN OUT. Reading from the wrong Brain costs nothing as long as the
 * answer says where it came from, so `queryKnowledge` asks EVERY configured
 * Brain and stamps each entry with its origin
 * (`metadata[BRAIN_ORIGIN_METADATA_KEY]`, read back with
 * {@link brainOriginOf}). Every target is settled independently, so one Brain
 * being down becomes an absence of results FROM THAT BRAIN, reported, and
 * never an empty answer that a model would read as "nothing is known".
 *
 * WRITES DO NOT. Writing to the wrong Brain is not recoverable the same way: a
 * personal note filed into a shared organisational memory is a disclosure, and
 * nobody finds out from the return value, which says "saved". So
 * `archiveKnowledge` has exactly ONE default destination, and reaching another
 * requires naming it through `BrainEntryInput.brain`. An unknown name THROWS
 * rather than falling back to the default -- falling back would turn a typo
 * into a misfiled secret.
 *
 * ── Where partiality is reported, and why there are two read methods ────────
 *
 * `BrainPort.queryKnowledge` returns `BrainEntry[]`. That shape has no channel
 * for "and one Brain did not answer", so this adapter adds
 * {@link MultiBrainPort.queryAcrossBrains}, which returns the same entries plus
 * what was reached and what was not. `queryKnowledge` stays exactly on
 * contract, with one rule that keeps it from ever lying: when EVERY target
 * failed it throws `BrainUnavailableError` instead of returning `[]`, because
 * a caller with no partiality channel must not be handed silence dressed as an
 * answer. A PARTIAL failure still returns what was found -- throwing there
 * would discard real results to report a fault.
 *
 * A WARNING FOR WHOEVER WIRES THIS INTO AN EXISTING FLEET, measured rather
 * than imagined. That throw is only a guard where the caller lets it through.
 * Forge wraps `queryKnowledge` in `.catch(() => [])` at FOURTEEN call sites
 * (compte 2026-08-29 :
 * `grep -rnE "catch\(\s*\(\s*\)\s*=>\s*\[\s*\]\s*\)" forge/src --include "*.ts"`
 * rend 14, aucun dans un test, tous a moins de six lignes d'un
 * `queryKnowledge`): every one of them would
 * turn this exception back into an empty list, which is precisely the silence
 * dressed as an answer the throw exists to prevent. Nothing is broken today,
 * because no Forge agent constructs a `MultiBrainPort` yet. The day one does,
 * those `catch` clauses must be revisited FIRST, or the guard will look
 * present and be absent, which is worse than never having added it.
 *
 * ── What this adapter does NOT fan out, and why ─────────────────────────────
 *
 * The `working` / `episodic` / `semantic` / `procedural` / `claims` planes are
 * taken from the default delegate alone. Two reasons, both structural rather
 * than provisional: their write methods carry the same "one destination" rule
 * as `archiveKnowledge` with no field to name a target, and their read methods
 * return types (`unknown`, `EpisodicEvent`, `Claim`, `ProceduralSkill`) carry
 * no place to stamp an origin -- a fanned-out `working.get()` would have to
 * pick one value out of several with no way to say which Brain it came from,
 * which is exactly the failure mode this module exists to prevent. Fanning a
 * plane out requires first giving its return type an origin field.
 *
 * @public
 */

import {
  type BrainEntry,
  type BrainEntryInput,
  type BrainPort,
  type BrainQueryFilters,
  BrainUnavailableError,
  type LessonInput,
  MemoryValidationError,
  type PostmortemInput,
} from "../ports/brain.js";
import { createHttpBrainAdapter } from "./brain-http.js";
import { type BrainRosterOptions, resolveBrainRoster } from "./brain-roster.js";

/**
 * Metadata key carrying the name of the Brain an entry came from.
 *
 * Underscore-prefixed because it is stamped by this adapter onto entries it
 * did not author: the prefix marks it as provenance rather than something the
 * writer stored, and keeps it out of the way of a caller's own metadata keys.
 *
 * @public
 */
export const BRAIN_ORIGIN_METADATA_KEY = "_brain";

/**
 * Which Brain an entry came from, or `undefined` for an entry that did not
 * pass through a {@link MultiBrainPort}. Never guess a default from
 * `undefined`: an unlabelled entry has an unknown origin, which is not the
 * same fact as "it came from the default one".
 *
 * @public
 */
export function brainOriginOf(entry: BrainEntry): string | undefined {
  const v = entry.metadata?.[BRAIN_ORIGIN_METADATA_KEY];
  return typeof v === "string" ? v : undefined;
}

/** A Brain that did not answer, and what it said on the way out. @public */
export interface UnreachedBrain {
  readonly brain: string;
  readonly reason: string;
}

/**
 * A fan-out read, with its own partiality attached.
 *
 * `unreachable` being non-empty means the answer is INCOMPLETE. A caller that
 * renders `entries` without it turns "we could not look everywhere" into
 * "there is nothing there".
 *
 * @public
 */
export interface MultiBrainQueryReport {
  /** Every entry found, each stamped with its origin. */
  readonly entries: readonly BrainEntry[];
  /** Names of the Brains that answered, whether or not they had results. */
  readonly reached: readonly string[];
  /** Brains that were not searched, with the reason. */
  readonly unreachable: readonly UnreachedBrain[];
}

/** @public */
export interface MultiBrainPort extends BrainPort {
  /** Every Brain this port can reach, default first. */
  readonly brains: readonly string[];
  /** The single default write destination. */
  readonly defaultBrain: string;
  /** {@link BrainPort.queryKnowledge} with the fan-out's partiality attached. */
  queryAcrossBrains(query: string, filters?: BrainQueryFilters): Promise<MultiBrainQueryReport>;
}

/** One Brain behind a {@link MultiBrainPort}. @public */
export interface MultiBrainDelegate {
  /** How a caller names it in `BrainEntryInput.brain`. Case-insensitive. */
  readonly name: string;
  readonly port: BrainPort;
  /** Exactly one delegate is the default; absent it, the first one is. */
  readonly isDefault?: boolean;
}

/** @public */
export interface MultiBrainPortOptions {
  readonly delegates: readonly MultiBrainDelegate[];
  /**
   * Sink for fan-out warnings. Defaults to `console.warn`, matching
   * `HttpBrainAdapterOptions.logger`; a host with a live TUI should inject a
   * quiet sink instead.
   */
  readonly logger?: (message: string, ...args: unknown[]) => void;
}

function stampOrigin(entry: BrainEntry, brain: string): BrainEntry {
  return {
    ...entry,
    metadata: { ...(entry.metadata ?? {}), [BRAIN_ORIGIN_METADATA_KEY]: brain },
  };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compose several `BrainPort`s into one.
 *
 * Delegate-agnostic on purpose: the delegates are plain `BrainPort`s, so a
 * host can compose HTTP adapters, an in-memory port under test, or its own
 * instrumented client, and the read/write asymmetry holds for all of them.
 *
 * @throws {MemoryValidationError} when no delegate is supplied, when two share
 * a name, or when more than one claims to be the default -- all three are
 * configuration bugs whose quiet form is a write landing somewhere unintended.
 *
 * @public
 */
export function createMultiBrainPort(opts: MultiBrainPortOptions): MultiBrainPort {
  const warn =
    opts.logger ?? ((message: string, ...args: unknown[]) => console.warn(message, ...args));

  const delegates = opts.delegates.map((d) => ({ ...d, name: d.name.trim().toLowerCase() }));
  if (delegates.length === 0) {
    throw new MemoryValidationError("createMultiBrainPort requires at least one delegate");
  }
  const dupes = delegates.map((d) => d.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dupes.length > 0) {
    throw new MemoryValidationError(`duplicate Brain name(s): ${[...new Set(dupes)].join(", ")}`);
  }
  const flagged = delegates.filter((d) => d.isDefault);
  if (flagged.length > 1) {
    throw new MemoryValidationError(
      `more than one default Brain: ${flagged.map((d) => d.name).join(", ")} ; exactly one write destination is the whole point`,
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: delegates is non-empty (checked above), so index 0 exists.
  const primary = flagged[0] ?? delegates[0]!;

  /**
   * An unknown name is refused HERE, at the last point before the write
   * leaves. Trusting the caller to have picked a real one is what turns a typo
   * into a note filed in the wrong memory.
   */
  function delegateFor(name: string | undefined): MultiBrainDelegate {
    if (name === undefined) return primary;
    const wanted = name.trim().toLowerCase();
    const found = delegates.find((d) => d.name === wanted);
    if (!found) {
      throw new MemoryValidationError(
        `unknown Brain "${name}" ; configured: ${delegates.map((d) => d.name).join(", ")}`,
      );
    }
    return found;
  }

  async function queryAcrossBrains(
    query: string,
    filters?: BrainQueryFilters,
  ): Promise<MultiBrainQueryReport> {
    const entries: BrainEntry[] = [];
    const reached: string[] = [];
    const unreachable: UnreachedBrain[] = [];

    // Settled INDEPENDENTLY: one Brain being down must not take the others'
    // results with it, and must not be rendered as "that Brain had nothing".
    const settled = await Promise.allSettled(
      delegates.map(async (d) => {
        if (!d.port.queryKnowledge) {
          // Not a transport failure, but from the caller's side it is the same
          // fact: this Brain was NOT searched. Reporting it as an answered
          // Brain with zero results would render an absence as a fact.
          throw new MemoryValidationError("delegate has no queryKnowledge implementation");
        }
        return d.port.queryKnowledge(query, filters);
      }),
    );

    settled.forEach((outcome, i) => {
      // biome-ignore lint/style/noNonNullAssertion: forEach index is always within delegates.
      const name = delegates[i]!.name;
      if (outcome.status === "rejected") {
        const reason = reasonOf(outcome.reason);
        unreachable.push({ brain: name, reason });
        warn(`[multi-brain] ${name} did not answer the query: ${reason}`);
        return;
      }
      reached.push(name);
      for (const e of outcome.value) entries.push(stampOrigin(e, name));
    });

    return { entries, reached, unreachable };
  }

  const port: MultiBrainPort = {
    brains: [primary.name, ...delegates.filter((d) => d !== primary).map((d) => d.name)],
    defaultBrain: primary.name,

    queryAcrossBrains,

    async queryKnowledge(query: string, filters?: BrainQueryFilters): Promise<BrainEntry[]> {
      const report = await queryAcrossBrains(query, filters);
      // TOTAL failure is not an empty result. A `BrainPort` caller has no
      // channel to learn the search never happened, so handing it `[]` would
      // let "we could not look" be read as "nothing is known" -- the exact
      // shape of the silent-absence bug this codebase keeps finding. A PARTIAL
      // failure still returns what was found; the caller that wants to know it
      // was partial calls queryAcrossBrains.
      if (report.reached.length === 0) {
        throw new BrainUnavailableError(
          `no Brain answered the query (${report.unreachable.map((u) => `${u.brain}: ${u.reason}`).join(" ; ")})`,
        );
      }
      return [...report.entries];
    },

    async archiveKnowledge(entry: BrainEntryInput): Promise<BrainEntry | null> {
      const { brain, ...rest } = entry;
      const target = delegateFor(brain);
      // `brain` is a ROUTING field, not a wire field: it is stripped here so
      // no adapter downstream can send it to a Brain that has no such column.
      const saved = await target.port.archiveKnowledge(rest);
      // The receipt says where it landed, for the same reason a read says
      // where it came from: "saved: true" alone leaves a caller with several
      // Brains unable to tell WHICH memory now holds the note.
      return saved ? stampOrigin(saved, target.name) : null;
    },

    // Both post-mortems and lessons are writes, so they follow the write rule:
    // the default destination, never a fan-out. Feature-detected, because the
    // port declares them optional and a delegate may not implement them.
    ...(primary.port.archivePostmortem
      ? {
          archivePostmortem: async (input: PostmortemInput): Promise<void> => {
            // biome-ignore lint/style/noNonNullAssertion: presence checked on the line above.
            await primary.port.archivePostmortem!(input);
          },
        }
      : {}),
    ...(primary.port.archiveLesson
      ? {
          archiveLesson: async (input: LessonInput): Promise<void> => {
            // biome-ignore lint/style/noNonNullAssertion: presence checked on the line above.
            await primary.port.archiveLesson!(input);
          },
        }
      : {}),

    // The four-plane surface comes from the default delegate alone -- see the
    // module doc for why fanning these out needs an origin field first.
    working: primary.port.working,
    episodic: primary.port.episodic,
    semantic: primary.port.semantic,
    procedural: primary.port.procedural,
    claims: primary.port.claims,
  };

  return port;
}

/** @public */
export interface MultiBrainFromEnvOptions extends BrainRosterOptions {
  /** Keys the Working Memory plane of the default delegate, as on the adapter. */
  readonly agentId?: string;
  readonly logger?: (message: string, ...args: unknown[]) => void;
  readonly timeoutMs?: number;
}

/**
 * Build a {@link MultiBrainPort} from the environment, or `undefined` when no
 * Brain is configured at all (mirroring `createBrainPortFromEnv`: a host with
 * no Brain gets no memory port rather than a broken one).
 *
 * Every dropped configuration group is reported through `logger` before the
 * port is returned. A Brain that was declared and is not in the roster must
 * never be lost in silence -- see `brain-roster.ts` for why.
 *
 * @public
 */
export function createMultiBrainPortFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: MultiBrainFromEnvOptions = {},
): MultiBrainPort | undefined {
  const warn =
    opts.logger ?? ((message: string, ...args: unknown[]) => console.warn(message, ...args));
  const roster = resolveBrainRoster(env, opts);
  for (const why of roster.skipped) warn(`[multi-brain] ${why}`);
  if (roster.targets.length === 0) return undefined;

  return createMultiBrainPort({
    logger: warn,
    delegates: roster.targets.map((t) => ({
      name: t.name,
      isDefault: t.isPrimary,
      port: createHttpBrainAdapter({
        baseUrl: t.baseUrl,
        brainId: t.brainId,
        ...(t.token ? { token: t.token } : {}),
        ...(t.apiKey ? { apiKey: t.apiKey } : {}),
        // Only the default delegate keys the Working Memory plane, since only
        // its planes are exposed (see the module doc).
        ...(t.isPrimary && opts.agentId ? { agentId: opts.agentId } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        logger: warn,
        // Load-bearing for the fan-out's honesty: the adapter's default is to
        // swallow a query failure and return [], which would reach this port
        // as "that Brain answered, with nothing" and make `unreachable` a
        // field that can never be populated.
        throwOnQueryFailure: true,
      }),
    })),
  });
}
