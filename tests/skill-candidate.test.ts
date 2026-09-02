/**
 * Tests for packages/agent-sdk/src/skill-loop/candidate.ts
 *
 * Coverage:
 *   extractCandidate — returns correct extractedFrom, domain, instructions, scores, version,
 *                      id is a 64-char hex SHA-256 string,
 *                      replayRoot is a 64-char hex SHA-256 string,
 *                      id equals SHA-256(cycleId + ":" + domain),
 *                      replayRoot equals SHA-256(cycleId + ":" + domain + ":" + instructions),
 *                      deterministic: same args produce identical output,
 *                      different cycleId produces different id,
 *                      different domain produces different id,
 *                      different instructions produces different replayRoot,
 *                      version is always "1.0.0",
 *                      constitutionalScore and outcomeScore are preserved exactly
 */

import { describe, expect, it } from "vitest";
import { sha256 } from "../src/proof/sha256.js";
import { extractCandidate } from "../src/skill-loop/candidate.js";

describe("extractCandidate", () => {
  const BASE = {
    cycleId: "cycle-001",
    instructions: "Always validate inputs before processing.",
    domain: "vault_rebalance",
    scores: { constitutional: 0.9, outcome: 0.85 },
  };

  it("preserves extractedFrom as the provided cycleId", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.extractedFrom).toBe(BASE.cycleId);
  });

  it("preserves domain", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.domain).toBe(BASE.domain);
  });

  it("preserves instructions", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.instructions).toBe(BASE.instructions);
  });

  it("preserves constitutionalScore", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.constitutionalScore).toBe(0.9);
  });

  it("preserves outcomeScore", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.outcomeScore).toBe(0.85);
  });

  it("always sets version to '1.0.0'", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.version).toBe("1.0.0");
  });

  it("id is a 64-character lowercase hex string", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replayRoot is a 64-character lowercase hex string", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c.replayRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("id equals SHA-256(cycleId + ':' + domain)", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    const expected = await sha256(`${BASE.cycleId}:${BASE.domain}`);
    expect(c.id).toBe(expected);
  });

  it("replayRoot equals SHA-256(cycleId + ':' + domain + ':' + instructions)", async () => {
    const c = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    const expected = await sha256(`${BASE.cycleId}:${BASE.domain}:${BASE.instructions}`);
    expect(c.replayRoot).toBe(expected);
  });

  it("is deterministic: same args produce identical id and replayRoot", async () => {
    const c1 = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    const c2 = await extractCandidate(BASE.cycleId, BASE.instructions, BASE.domain, BASE.scores);
    expect(c1.id).toBe(c2.id);
    expect(c1.replayRoot).toBe(c2.replayRoot);
  });

  it("different cycleId produces a different id", async () => {
    const c1 = await extractCandidate("cycle-A", BASE.instructions, BASE.domain, BASE.scores);
    const c2 = await extractCandidate("cycle-B", BASE.instructions, BASE.domain, BASE.scores);
    expect(c1.id).not.toBe(c2.id);
  });

  it("different domain produces a different id", async () => {
    const c1 = await extractCandidate(
      BASE.cycleId,
      BASE.instructions,
      "vault_rebalance",
      BASE.scores,
    );
    const c2 = await extractCandidate(BASE.cycleId, BASE.instructions, "cairo_audit", BASE.scores);
    expect(c1.id).not.toBe(c2.id);
  });

  it("different instructions produces a different replayRoot", async () => {
    const c1 = await extractCandidate(BASE.cycleId, "instructions A", BASE.domain, BASE.scores);
    const c2 = await extractCandidate(BASE.cycleId, "instructions B", BASE.domain, BASE.scores);
    expect(c1.replayRoot).not.toBe(c2.replayRoot);
  });

  it("same cycleId + domain but different instructions leaves id unchanged", async () => {
    const c1 = await extractCandidate(BASE.cycleId, "text one", BASE.domain, BASE.scores);
    const c2 = await extractCandidate(BASE.cycleId, "text two", BASE.domain, BASE.scores);
    // id depends only on cycleId + domain, not instructions
    expect(c1.id).toBe(c2.id);
  });

  it("handles empty strings for cycleId and domain without throwing", async () => {
    const c = await extractCandidate("", "", "", {
      constitutional: 0,
      outcome: 0,
    });
    expect(c.id).toMatch(/^[0-9a-f]{64}$/);
    expect(c.replayRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});
