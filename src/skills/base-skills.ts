/**
 * Base Skills — universal skills available to all agent consumers.
 *
 * Every skill registry built via `buildSkills()` includes these by default.
 * Domain-specific extras are layered on top per consumer configuration.
 *
 * Skills intentionally NOT base (must be explicitly granted per agent):
 * - http-fetch: gateway to arbitrary external APIs
 * - send-email: user-facing communication channel
 * - telegram-notify: ops channel (write access)
 * - run-sql-query: raw data access
 * - prometheus-query: infra read access
 *
 * @public @since 0.18.0
 */

import type { Skill } from "../orchestration/ooda/skills.js";

/**
 * Names of skills included in every base registry.
 * Exposed so consumers can assert or enumerate defaults.
 * @public
 */
export const BASE_SKILL_NAMES = [
  "brain-query",
  "brain-store",
  "slack-notify",
  "llm-complete",
] as const satisfies readonly string[];

/** @public */
export type BaseSkillName = (typeof BASE_SKILL_NAMES)[number];

/**
 * Descriptor for a domain skill: a name + the Skill implementation.
 * @public
 */
export interface DomainSkillEntry {
  readonly name: string;
  readonly skill: Skill;
}
