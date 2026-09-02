/**
 * Tests for:
 *   agent-sdk/src/skill-loop/reflexion-replay.ts
 *
 * Coverage (ReflexionStore):
 *   1.  New store has size 0
 *   2.  store() returns a ReflexionEntry with replayHash, skillId, domain
 *   3.  store() replayHash is a 64-char hex string
 *   4.  store() instructionsHash is a 64-char hex string (SHA-256 of instructions)
 *   5.  store() lesson field matches input
 *   6.  store() scores field matches input
 *   7.  store() storedAt is a valid ISO-8601 timestamp
 *   8.  store() determinism: same args produce same replayHash
 *   9.  store() different instructions produce different replayHash
 *   10. store() different domain produces different replayHash
 *   11. store() different skillId produces different replayHash
 *   12. size increases after each store()
 *   13. replay() returns null for unknown hash
 *   14. replay() after store() returns identical=true
 *   15. replay() bit-identical: lesson matches original
 *   16. replay() bit-identical: scores match original
 *   17. replay() replayHash matches original
 *   18. get() by replayHash returns entry or null for unknown hash
 *   19. listBySkill() filters by skillId
 *   20. listBySkill() returns empty array for unknown skill
 *   21. clear() resets size to 0
 *   22. clear() makes replay() return null
 *   23. Multiple stores with same args return the same entry (idempotent)
 *   24. Store with empty lesson works
 *   25. Reflexion entries are isolated per store instance
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ReflexionStore } from "../src/skill-loop/reflexion-replay.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ─── Test data ────────────────────────────────────────────────────────────────

const SKILL_ID = "web-search";
const DOMAIN = "market-research";
const INSTRUCTIONS = "Search the web for relevant information on the topic.";
const LESSON = "Prefer recent sources when domain is volatile.";
const SCORES = { constitutional: 0.85, outcome: 0.72 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReflexionStore", () => {
  let store: ReflexionStore;

  beforeEach(() => {
    store = new ReflexionStore();
  });

  // 1. New store has size 0
  it("new store has size 0", () => {
    expect(store.size).toBe(0);
  });

  // 2. store() returns entry with expected fields
  it("store() returns a ReflexionEntry with replayHash, skillId, domain", () => {
    const entry = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(entry).toMatchObject({
      skillId: SKILL_ID,
      domain: DOMAIN,
      lesson: LESSON,
    });
    expect(typeof entry.replayHash).toBe("string");
  });

  // 3. store() replayHash is a 64-char hex string
  it("store() replayHash is a 64-char lowercase hex string", () => {
    const { replayHash } = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(HEX64_RE.test(replayHash)).toBe(true);
  });

  // 4. store() instructionsHash is SHA-256 of instructions
  it("store() instructionsHash is a 64-char hex string matching SHA-256 of instructions", () => {
    const { instructionsHash } = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(HEX64_RE.test(instructionsHash)).toBe(true);
    expect(instructionsHash).toBe(sha256Hex(INSTRUCTIONS));
  });

  // 5. store() lesson field matches input
  it("store() lesson field matches the input lesson", () => {
    const { lesson } = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(lesson).toBe(LESSON);
  });

  // 6. store() scores field matches input
  it("store() scores field matches the input scores", () => {
    const { scores } = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(scores).toEqual(SCORES);
  });

  // 7. store() storedAt is a valid ISO-8601 timestamp
  it("store() storedAt is a valid ISO-8601 timestamp", () => {
    const { storedAt } = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(ISO8601_RE.test(storedAt)).toBe(true);
    expect(Number.isNaN(Date.parse(storedAt))).toBe(false);
  });

  // 8. store() determinism: same args → same replayHash
  it("store() determinism: same args produce the same replayHash", () => {
    const a = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    store.clear();
    const b = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(a.replayHash).toBe(b.replayHash);
  });

  // 9. store() different instructions → different replayHash
  it("store() different instructions produce a different replayHash", () => {
    const a = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const b = store.store(SKILL_ID, DOMAIN, "Completely different instructions.", LESSON, SCORES);
    expect(a.replayHash).not.toBe(b.replayHash);
  });

  // 10. store() different domain → different replayHash
  it("store() different domain produces a different replayHash", () => {
    const a = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const b = store.store(SKILL_ID, "other-domain", INSTRUCTIONS, LESSON, SCORES);
    expect(a.replayHash).not.toBe(b.replayHash);
  });

  // 11. store() different skillId → different replayHash
  it("store() different skillId produces a different replayHash", () => {
    const a = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const b = store.store("brain-query", DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(a.replayHash).not.toBe(b.replayHash);
  });

  // 12. size increases after each store()
  it("size increases after each store()", () => {
    expect(store.size).toBe(0);
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    expect(store.size).toBe(1);
    store.store("brain-query", "finance", "Do brain query.", "Use filters.", {
      constitutional: 0.9,
      outcome: 0.8,
    });
    expect(store.size).toBe(2);
  });

  // 13. replay() returns null for unknown hash
  it("replay() returns null for an unregistered combination", () => {
    const result = store.replay("unknown-skill", "unknown-domain", "unknown");
    expect(result).toBeNull();
  });

  // 14. replay() after store() returns identical=true
  it("replay() after store() returns identical=true", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result).not.toBeNull();
    expect(result!.identical).toBe(true);
  });

  // 15. replay() bit-identical: lesson matches original
  it("replay() returns the bit-identical lesson from the stored entry", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result!.lesson).toBe(LESSON);
  });

  // 16. replay() bit-identical: scores match original
  it("replay() returns the bit-identical scores from the stored entry", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result!.scores).toEqual(SCORES);
  });

  // 17. replay() replayHash matches original
  it("replay() replayHash matches the hash returned by store()", () => {
    const entry = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result!.replayHash).toBe(entry.replayHash);
  });

  // 18. get() by replayHash returns entry; null for unknown
  it("get() returns the entry for a known replayHash and null for an unknown one", () => {
    const entry = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const found = store.get(entry.replayHash);
    expect(found).not.toBeNull();
    expect(found!.replayHash).toBe(entry.replayHash);

    const missing = store.get("0".repeat(64));
    expect(missing).toBeNull();
  });

  // 19. listBySkill() filters by skillId
  it("listBySkill() returns only entries matching the requested skillId", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    store.store(SKILL_ID, "other-domain", "other instructions", "other lesson", {
      constitutional: 0.5,
      outcome: 0.5,
    });
    store.store("brain-query", "finance", "brain instructions", "brain lesson", {
      constitutional: 0.9,
      outcome: 0.8,
    });

    const results = store.listBySkill(SKILL_ID);
    expect(results).toHaveLength(2);
    for (const e of results) {
      expect(e.skillId).toBe(SKILL_ID);
    }
  });

  // 20. listBySkill() returns empty array for unknown skill
  it("listBySkill() returns an empty array for an unregistered skillId", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    const results = store.listBySkill("nonexistent-skill");
    expect(results).toEqual([]);
  });

  // 21. clear() resets size to 0
  it("clear() resets size to 0", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    store.store("brain-query", "finance", "x", "y", {
      constitutional: 1,
      outcome: 1,
    });
    expect(store.size).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
  });

  // 22. clear() makes replay() return null
  it("clear() makes replay() return null for previously stored entries", () => {
    store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);
    store.clear();
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result).toBeNull();
  });

  // 23. Multiple stores with same args return same entry (idempotent / overwrites)
  it("storing with the same args twice overwrites and returns bit-identical entry", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const a = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES, now);
    const b = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES, now);
    expect(a.replayHash).toBe(b.replayHash);
    expect(a.instructionsHash).toBe(b.instructionsHash);
    expect(a.lesson).toBe(b.lesson);
    expect(a.scores).toEqual(b.scores);
    // Size stays 1 because same key overwrites
    expect(store.size).toBe(1);
  });

  // 24. Store with empty lesson works
  it("store() accepts an empty string as lesson", () => {
    const entry = store.store(SKILL_ID, DOMAIN, INSTRUCTIONS, "", SCORES);
    expect(entry.lesson).toBe("");
    const result = store.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(result!.lesson).toBe("");
  });

  // 25. Reflexion entries are isolated per store instance
  it("entries are isolated between two distinct ReflexionStore instances", () => {
    const storeA = new ReflexionStore();
    const storeB = new ReflexionStore();

    storeA.store(SKILL_ID, DOMAIN, INSTRUCTIONS, LESSON, SCORES);

    expect(storeA.size).toBe(1);
    expect(storeB.size).toBe(0);

    const replayInB = storeB.replay(SKILL_ID, DOMAIN, INSTRUCTIONS);
    expect(replayInB).toBeNull();
  });
});
