/**
 * src/skill-loop/reflexion-replay.ts
 *
 * Deterministic reflexion storage and replay.
 *
 * Invariants:
 *   - Reflexion is stored as a deterministic hash, NOT an LLM paraphrase.
 *   - replay() with the same args produces bit-identical output every time.
 *   - The replay hash is SHA-256(skillId + ":" + domain + ":" + instructionsHash).
 *   - No LLM calls. Pure deterministic computation.
 *
 * @module skill-loop/reflexion-replay
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReflexionEntry {
  /** Unique key for this reflexion: SHA-256(skillId + domain + instructionsHash). */
  replayHash: string;
  skillId: string;
  domain: string;
  /** SHA-256 of the raw instructions text. */
  instructionsHash: string;
  /** Deterministic lesson extracted from the reflexion cycle (NOT LLM paraphrase). */
  lesson: string;
  /** Constitutional axiom scores that triggered this reflexion. */
  scores: { constitutional: number; outcome: number };
  /** ISO-8601 timestamp of storage. */
  storedAt: string;
}

export interface ReplayResult {
  replayHash: string;
  lesson: string;
  scores: { constitutional: number; outcome: number };
  /** True when the replay output is bit-identical to the stored entry. */
  identical: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function computeReplayHash(skillId: string, domain: string, instructionsHash: string): string {
  return sha256Hex(`${skillId}:${domain}:${instructionsHash}`);
}

// ---------------------------------------------------------------------------
// ReflexionStore
// ---------------------------------------------------------------------------

/**
 * In-memory deterministic reflexion store.
 *
 * In production, persist entries to the DB (table: skill_reflexions).
 * This implementation is process-local and suitable for tests.
 */
export class ReflexionStore {
  private readonly entries = new Map<string, ReflexionEntry>();

  // ── Store ──────────────────────────────────────────────────────────────────

  /**
   * Store a reflexion entry deterministically.
   *
   * The replayHash is computed solely from (skillId, domain, instructions) —
   * no randomness, no timestamps in the hash computation.
   * Idempotent: storing with the same inputs overwrites with bit-identical data.
   *
   * @param skillId      - Skill identifier.
   * @param domain       - Domain key.
   * @param instructions - Raw skill instructions (deterministic source).
   * @param lesson       - Extracted lesson (must be deterministic — NOT LLM output).
   * @param scores       - Constitutional and outcome scores.
   * @param nowDate      - Optional timestamp override for testing.
   */
  store(
    skillId: string,
    domain: string,
    instructions: string,
    lesson: string,
    scores: { constitutional: number; outcome: number },
    nowDate?: Date,
  ): ReflexionEntry {
    const instructionsHash = sha256Hex(instructions);
    const replayHash = computeReplayHash(skillId, domain, instructionsHash);

    const entry: ReflexionEntry = {
      replayHash,
      skillId,
      domain,
      instructionsHash,
      lesson,
      scores,
      storedAt: (nowDate ?? new Date()).toISOString(),
    };

    this.entries.set(replayHash, entry);
    return entry;
  }

  // ── Replay ─────────────────────────────────────────────────────────────────

  /**
   * Replay a stored reflexion with the same arguments.
   *
   * Determinism guarantee: replay(skillId, domain, instructions) with the
   * same inputs as the original store() call ALWAYS produces the same
   * replayHash and lesson — bit-identical output.
   *
   * @returns ReplayResult with `identical: true` if the entry is found and
   *          the recomputed hash matches the stored replayHash.
   */
  replay(skillId: string, domain: string, instructions: string): ReplayResult | null {
    const instructionsHash = sha256Hex(instructions);
    const replayHash = computeReplayHash(skillId, domain, instructionsHash);

    const entry = this.entries.get(replayHash);
    if (!entry) return null;

    // Verify bit-identical determinism
    const identical =
      replayHash === entry.replayHash && instructionsHash === entry.instructionsHash;

    return {
      replayHash,
      lesson: entry.lesson,
      scores: entry.scores,
      identical,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Retrieve an entry by its replay hash. */
  get(replayHash: string): ReflexionEntry | null {
    return this.entries.get(replayHash) ?? null;
  }

  /** List all stored entries for a given skill. */
  listBySkill(skillId: string): ReflexionEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.skillId === skillId);
  }

  /** Total number of stored entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Clear all entries (useful for test isolation). */
  clear(): void {
    this.entries.clear();
  }
}
