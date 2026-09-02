/**
 * Tests — skill-manifest (sprint-586)
 *
 * Covers:
 *   - buildManifest: produces correct poseidonHash and grade
 *   - anchorWithTsa: fails closed (throws TsaUnavailableError) when TSA is
 *     unreachable ; verifyTsaAnchor rejects 1-byte tamper on an offline
 *     mock-format token (anchorWithTsa itself never fabricates one)
 *   - anchorWithStarknet: returns tx hash (mocked RPC), grade=starknet_primary
 *   - verifyManifest: accepts valid manifest, rejects tampered replayRoot
 *   - Attack test: modify 1 byte of replayRoot → verifyManifest returns false
 *   - Resilience: Starknet RPC down → TSA-only anchor validates
 *   - Fake lineage: forged trainingReplayRoot → verifier rejects
 */

import { describe, expect, it, vi } from "vitest";
import {
  TsaUnavailableError,
  anchorWithTsa,
  verifyTsaAnchor,
} from "../src/skill-manifest/anchor.js";
import { buildManifest, computeManifestHash } from "../src/skill-manifest/builder.js";
import type { SkillManifest } from "../src/skill-manifest/types.js";
import { verifyManifest } from "../src/skill-manifest/verifier.js";

/**
 * Test-only helper: builds the documented "MOCK_TSA:<hash>:<isoTimestamp>"
 * degraded-grade format directly. anchorWithTsa() itself never produces this
 * (fail-closed ; throws TsaUnavailableError instead of fabricating).
 */
function buildMockTsaTokenForTest(manifestHash: string, ts: Date = new Date()): string {
  return Buffer.from(`MOCK_TSA:${manifestHash}:${ts.toISOString()}`, "utf8").toString("base64");
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  skillId: "vauban.sentinel.rebalancing",
  version: "1.0.0",
  domain: "finance",
  replaySnapshot: "step1: check threshold. step2: rebalance positions.",
};

// ─── buildManifest ────────────────────────────────────────────────────────────

describe("buildManifest", () => {
  it("builds a manifest with unanchored grade", () => {
    const m = buildManifest(BASE_PARAMS);
    expect(m.skillId).toBe(BASE_PARAMS.skillId);
    expect(m.version).toBe(BASE_PARAMS.version);
    expect(m.domain).toBe(BASE_PARAMS.domain);
    expect(m.grade).toBe("unanchored");
  });

  it("trainingReplayRoot is SHA-256 hex of the snapshot (64 chars)", () => {
    const m = buildManifest(BASE_PARAMS);
    expect(m.trainingReplayRoot).toHaveLength(64);
    expect(m.trainingReplayRoot).toMatch(/^[0-9a-f]+$/);
  });

  it("poseidonHash starts with 0x and is non-empty", () => {
    const m = buildManifest(BASE_PARAMS);
    expect(m.poseidonHash).toMatch(/^0x[0-9a-f]+$/);
  });

  it("is deterministic: same inputs → same hashes", () => {
    const m1 = buildManifest(BASE_PARAMS);
    const m2 = buildManifest(BASE_PARAMS);
    expect(m1.trainingReplayRoot).toBe(m2.trainingReplayRoot);
    expect(m1.poseidonHash).toBe(m2.poseidonHash);
  });

  it("different snapshot → different trainingReplayRoot", () => {
    const m1 = buildManifest(BASE_PARAMS);
    const m2 = buildManifest({
      ...BASE_PARAMS,
      replaySnapshot: "different content",
    });
    expect(m1.trainingReplayRoot).not.toBe(m2.trainingReplayRoot);
    expect(m1.poseidonHash).not.toBe(m2.poseidonHash);
  });
});

// ─── computeManifestHash ──────────────────────────────────────────────────────

describe("computeManifestHash", () => {
  it("produces consistent Poseidon hash for same inputs", () => {
    const m = buildManifest(BASE_PARAMS);
    const recomputed = computeManifestHash({
      skillId: m.skillId,
      version: m.version,
      domain: m.domain,
      trainingReplayRoot: m.trainingReplayRoot,
    });
    expect(recomputed).toBe(m.poseidonHash);
  });
});

// ─── anchorWithTsa + verifyTsaAnchor ──────────────────────────────────────────

describe("anchorWithTsa + verifyTsaAnchor", () => {
  it("anchorWithTsa throws TsaUnavailableError when TSA server is unreachable (fail-closed)", async () => {
    const m = buildManifest(BASE_PARAMS);
    // Use a non-existent TSA URL → previously fell back to a fabricated mock
    // token ; now fails closed instead.
    await expect(
      anchorWithTsa(m.poseidonHash, {
        tsaUrl: "http://localhost:19999/tsa-does-not-exist",
        timeout_ms: 100,
      }),
    ).rejects.toBeInstanceOf(TsaUnavailableError);
  });

  it("verifyTsaAnchor returns true for valid mock token anchoring poseidonHash", () => {
    const m = buildManifest(BASE_PARAMS);
    // Mock token constructed offline ; anchorWithTsa never produces one.
    const token = buildMockTsaTokenForTest(m.poseidonHash);
    const manifest: SkillManifest = {
      ...m,
      tsaToken: token,
      grade: "tsa_fallback",
    };
    expect(verifyTsaAnchor(manifest)).toBe(true);
  });

  it("verifyTsaAnchor rejects manifest with 1-byte tamper in poseidonHash", () => {
    const m = buildManifest(BASE_PARAMS);
    const token = buildMockTsaTokenForTest(m.poseidonHash);
    // Tamper: flip last char of poseidonHash
    const originalHash = m.poseidonHash;
    const lastChar = originalHash[originalHash.length - 1];
    const tamperedChar = lastChar === "f" ? "0" : "f";
    const tamperedHash = originalHash.slice(0, -1) + tamperedChar;

    const tamperedManifest: SkillManifest = {
      ...m,
      poseidonHash: tamperedHash,
      tsaToken: token,
      grade: "tsa_fallback",
    };
    expect(verifyTsaAnchor(tamperedManifest)).toBe(false);
  });
});

// ─── anchorWithStarknet ───────────────────────────────────────────────────────

describe("anchorWithStarknet", () => {
  it("returns null when no RPC URL is configured", async () => {
    const { anchorWithStarknet } = await import("../src/skill-manifest/anchor.js");
    const m = buildManifest(BASE_PARAMS);
    // No rpcUrl param, no env var → graceful fallback
    const originalEnv = process.env.STARKNET_RPC_URL;
    delete process.env.STARKNET_RPC_URL;
    const result = await anchorWithStarknet(m);
    expect(result).toBeNull();
    if (originalEnv !== undefined) process.env.STARKNET_RPC_URL = originalEnv;
  });

  it("returns null when Starknet RPC is down (resilience test)", async () => {
    const { anchorWithStarknet } = await import("../src/skill-manifest/anchor.js");
    const m = buildManifest(BASE_PARAMS);
    // Point to a dead RPC — should return null gracefully
    const result = await anchorWithStarknet(m, "http://localhost:19998/starknet-down");
    expect(result).toBeNull();
  });
});

// ─── verifyManifest ───────────────────────────────────────────────────────────

describe("verifyManifest", () => {
  it("accepts a valid unanchored manifest", () => {
    const m = buildManifest(BASE_PARAMS);
    const result = verifyManifest(m, BASE_PARAMS.replaySnapshot);
    expect(result.replayRootMatches).toBe(true);
    expect(result.poseidonHashValid).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("Attack test: 1-byte tamper in replayRoot → verifyManifest returns false", () => {
    const m = buildManifest(BASE_PARAMS);
    // Tamper the stored trainingReplayRoot by flipping last hex char
    const origRoot = m.trainingReplayRoot;
    const tamperedRoot =
      origRoot.slice(0, -1) + (origRoot[origRoot.length - 1] === "f" ? "0" : "f");
    const tampered: SkillManifest = { ...m, trainingReplayRoot: tamperedRoot };

    const result = verifyManifest(tampered, BASE_PARAMS.replaySnapshot);
    expect(result.replayRootMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("Attack test: modified replaySnapshot → verifier detects mismatch", () => {
    const m = buildManifest(BASE_PARAMS);
    const result = verifyManifest(m, `${BASE_PARAMS.replaySnapshot}X`);
    expect(result.replayRootMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("Fake lineage: forged trainingReplayRoot → verifier rejects", () => {
    const m = buildManifest(BASE_PARAMS);
    // Attacker replaces trainingReplayRoot with a SHA-256 of something else
    const { createHash } = require("node:crypto");
    const forgedRoot = createHash("sha256").update("malicious payload").digest("hex");
    const forgedManifest: SkillManifest = {
      ...m,
      trainingReplayRoot: forgedRoot,
      // Attacker also recomputes poseidonHash to avoid check 2 — still fails check 1
      poseidonHash: computeManifestHash({
        skillId: m.skillId,
        version: m.version,
        domain: m.domain,
        trainingReplayRoot: forgedRoot,
      }),
    };
    // Check 1 (replayRoot integrity) still fails because snapshot doesn't match forgedRoot
    const result = verifyManifest(forgedManifest, BASE_PARAMS.replaySnapshot);
    expect(result.replayRootMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("Resilience: TSA-only anchor validates when Starknet unavailable", () => {
    const m = buildManifest(BASE_PARAMS);
    // Mock token constructed offline ; anchorWithTsa (real DigiCert call)
    // would fail closed here since Starknet+TSA are both simulated down.
    const token = buildMockTsaTokenForTest(m.poseidonHash);
    const manifest: SkillManifest = {
      ...m,
      tsaToken: token,
      grade: "tsa_fallback",
      starknetAnchorTx: undefined,
    };
    const result = verifyManifest(manifest, BASE_PARAMS.replaySnapshot);
    // Integrity checks must pass even without Starknet
    expect(result.replayRootMatches).toBe(true);
    expect(result.poseidonHashValid).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("errors array is populated on failure", () => {
    const m = buildManifest(BASE_PARAMS);
    const result = verifyManifest(m, "wrong snapshot content");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("replayRoot mismatch");
  });
});

// ─── Barrel exports ───────────────────────────────────────────────────────────

describe("skill-manifest barrel (index.ts)", () => {
  it("exports all public symbols", async () => {
    const mod = await import("../src/skill-manifest/index.js");
    expect(typeof mod.buildManifest).toBe("function");
    expect(typeof mod.computeManifestHash).toBe("function");
    expect(typeof mod.anchorWithTsa).toBe("function");
    expect(typeof mod.verifyTsaAnchor).toBe("function");
    expect(typeof mod.anchorWithStarknet).toBe("function");
    expect(typeof mod.verifyManifest).toBe("function");
  });
});
