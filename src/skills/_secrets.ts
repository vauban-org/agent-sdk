/**
 * Internal helper for skills that read configuration secrets.
 *
 * Prefers `ctx.secrets` (audit-trail-bearing per ADR-ECO-036) over
 * `process.env` when a {@link SecretsAccessor} is configured on the
 * {@link SkillContext}. Falls back to env when no accessor is wired so
 * legacy callers see no behavior change.
 *
 * Returns `undefined` when the secret is configured nowhere — callers
 * decide whether that's a SkillNotConfiguredError or a soft default.
 *
 * @internal
 */

import type { SkillContext } from "../orchestration/ooda/skills.js";

export function readSecret(ctx: SkillContext, name: string): string | undefined {
  if (ctx.secrets?.has(name)) {
    return ctx.secrets.get(name);
  }
  return process.env[name];
}
