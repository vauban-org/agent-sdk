/**
 * src/skill-loop/versioning.ts
 *
 * Skill version management — semver bumping and version record type.
 *
 * Bump rules:
 *   - reflexion / ab_winner  → minor bump (1.0.0 → 1.1.0)
 *   - manual                 → major bump (1.0.0 → 2.0.0)
 *   - initial                → no-op (returns "1.0.0" baseline)
 *
 * @module skill-loop/versioning
 * @public
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillVersion {
  skillId: string;
  /** Semver string: "1.0.0", "1.1.0", etc. */
  version: string;
  parentSkillId: string | null;
  mutationType: "initial" | "reflexion" | "ab_winner" | "manual";
  /** SHA-256 of the source cycle trace. */
  replayRoot: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Version bumping
// ---------------------------------------------------------------------------

/**
 * Bump a semver string according to mutation type.
 *
 * - initial    → returns "1.0.0" (baseline, not a bump)
 * - reflexion  → minor bump
 * - ab_winner  → minor bump
 * - manual     → major bump
 *
 * @param current      - Current semver string e.g. "1.2.3".
 * @param mutationType - The kind of mutation that produced the new version.
 * @returns New semver string.
 */
export function bumpVersion(current: string, mutationType: SkillVersion["mutationType"]): string {
  if (mutationType === "initial") {
    return "1.0.0";
  }

  const parts = current.split(".");
  if (parts.length !== 3) {
    throw new Error(`bumpVersion: invalid semver "${current}" — expected "MAJOR.MINOR.PATCH"`);
  }

  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);

  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`bumpVersion: non-numeric semver components in "${current}"`);
  }

  if (mutationType === "manual") {
    return `${major + 1}.0.0`;
  }

  // reflexion | ab_winner → minor bump
  return `${major}.${minor + 1}.0`;
}
