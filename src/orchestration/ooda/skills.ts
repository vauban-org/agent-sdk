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

import type { DbClient } from "../../tracking/agent-run-tracker.js";
import type { LoggerPort } from "../../ports/logger.js";

/**
 * Context handed to each skill invocation.
 *
 * `isReplay` MUST be honored by skills that have side-effects: when true,
 * the skill must short-circuit and emit no observable mutation (no LLM
 * call, no HTTP, no DB INSERT). This guarantees replay safety for the
 * OODA cycle log.
 */
export interface SkillContext {
  readonly isReplay: boolean;
  readonly dryRunMocks: Record<string, (input: unknown) => unknown>;
  readonly db: DbClient;
  readonly logger: LoggerPort;
}

/**
 * Skill — single named callable unit invoked from an OODA phase.
 *
 * `inputSchema` is typed `unknown` here to keep the registry value-type
 * homogeneous. Concrete skill libraries may use Zod (already a SDK dep)
 * to refine the input — but validation is enforced inside `execute`.
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
 */
export type SkillRegistry = Record<string, Skill>;

/**
 * Empty registry — convenience for tests and minimal agents.
 */
export const EMPTY_SKILL_REGISTRY: SkillRegistry = Object.freeze({});
