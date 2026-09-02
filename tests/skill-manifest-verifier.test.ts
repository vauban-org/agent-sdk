/**
 * Tests — skill-manifest/verifier (sprint-586)
 *
 * Covers verifyManifest exhaustively:
 *   - Valid unanchored manifest passes integrity checks
 *   - replayRootMatches behaviour (correct, tampered snapshot, tampered manifest field)
 *   - poseidonHashValid behaviour (correct, wrong hash stored)
 *   - tsaAnchorValid: false when no tsaToken present
 *   - starknetAnchorValid: false when no witness supplied
 *   - starknetAnchorValid: false for type='none' witness
 *   - starknetAnchorValid: true for degenerate single-leaf Starknet tree
 *   - starknetAnchorValid: tsa-type witness leaves starknetAnchorValid=false
 *   - Result structure: all 7 fields present
 *   - errors is empty when all checks pass (unanchored grade warning aside)
 *   - errors contains replayRoot mismatch message on snapshot tamper
 *   - errors contains poseidonHash mismatch message on hash tamper
 *   - valid=false when replayRootMatches=false
 *   - valid=false when poseidonHashValid=false
 *   - valid=true when only anchor checks fail (integrity intact)
 *   - grade is propagated from manifest verbatim
 *   - Buffer replaySnapshot supported as input
 *   - 0x-prefixed poseidonHash is normalised for comparison
 *   - errors carry 'grade=unanchored' warning for unanchored manifests
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildManifest, computeManifestHash } from "../src/skill-manifest/builder.js";
import type { AnchorWitness, SkillManifest } from "../src/skill-manifest/types.js";
import { verifyManifest } from "../src/skill-manifest/verifier.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SNAPSHOT = "replay: buy 10 BTC at market. settle T+1.";

const BASE_PARAMS = {
  skillId: "vauban.finance.dca",
  version: "2.1.0",
  domain: "finance",
  replaySnapshot: SNAPSHOT,
};

function freshManifest(): SkillManifest {
  return buildManifest(BASE_PARAMS);
}

// ─── Result structure ─────────────────────────────────────────────────────────

describe("verifyManifest — result structure", () => {
  it("returns an object with all 7 required fields", () => {
    const m = freshManifest();
    const result = verifyManifest(m, SNAPSHOT);
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("replayRootMatches");
    expect(result).toHaveProperty("poseidonHashValid");
    expect(result).toHaveProperty("tsaAnchorValid");
    expect(result).toHaveProperty("starknetAnchorValid");
    expect(result).toHaveProperty("grade");
    expect(result).toHaveProperty("errors");
  });

  it("errors is an Array", () => {
    const m = freshManifest();
    const result = verifyManifest(m, SNAPSHOT);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("grade matches the manifest grade field verbatim", () => {
    const m = freshManifest(); // grade = 'unanchored'
    expect(verifyManifest(m, SNAPSHOT).grade).toBe("unanchored");
  });

  it("grade=tsa_fallback propagated correctly", () => {
    const m: SkillManifest = { ...freshManifest(), grade: "tsa_fallback" };
    expect(verifyManifest(m, SNAPSHOT).grade).toBe("tsa_fallback");
  });

  it("grade=starknet_primary propagated correctly", () => {
    const m: SkillManifest = { ...freshManifest(), grade: "starknet_primary" };
    expect(verifyManifest(m, SNAPSHOT).grade).toBe("starknet_primary");
  });
});

// ─── replayRootMatches ────────────────────────────────────────────────────────

describe("verifyManifest — replayRootMatches", () => {
  it("is true when replaySnapshot matches manifest.trainingReplayRoot", () => {
    const m = freshManifest();
    expect(verifyManifest(m, SNAPSHOT).replayRootMatches).toBe(true);
  });

  it("is false when replaySnapshot is tampered by appending a byte", () => {
    const m = freshManifest();
    expect(verifyManifest(m, `${SNAPSHOT}X`).replayRootMatches).toBe(false);
  });

  it("is false when trainingReplayRoot in manifest is tampered", () => {
    const m = freshManifest();
    const orig = m.trainingReplayRoot;
    const flipped = orig.slice(0, -1) + (orig[orig.length - 1] === "0" ? "f" : "0");
    const tampered: SkillManifest = { ...m, trainingReplayRoot: flipped };
    expect(verifyManifest(tampered, SNAPSHOT).replayRootMatches).toBe(false);
  });

  it("accepts a Buffer replaySnapshot and matches correctly", () => {
    const m = freshManifest();
    const buf = Buffer.from(SNAPSHOT, "utf8");
    expect(verifyManifest(m, buf).replayRootMatches).toBe(true);
  });

  it("Buffer and string snapshot produce same replayRootMatches", () => {
    const m = freshManifest();
    const fromStr = verifyManifest(m, SNAPSHOT).replayRootMatches;
    const fromBuf = verifyManifest(m, Buffer.from(SNAPSHOT, "utf8")).replayRootMatches;
    expect(fromStr).toBe(fromBuf);
  });
});

// ─── poseidonHashValid ────────────────────────────────────────────────────────

describe("verifyManifest — poseidonHashValid", () => {
  it("is true when poseidonHash matches the recomputed Poseidon commitment", () => {
    const m = freshManifest();
    expect(verifyManifest(m, SNAPSHOT).poseidonHashValid).toBe(true);
  });

  it("is false when poseidonHash is wrong (last char flipped)", () => {
    const m = freshManifest();
    const orig = m.poseidonHash;
    const flipped = orig.slice(0, -1) + (orig[orig.length - 1] === "0" ? "f" : "0");
    const bad: SkillManifest = { ...m, poseidonHash: flipped };
    expect(verifyManifest(bad, SNAPSHOT).poseidonHashValid).toBe(false);
  });

  it("is true when poseidonHash has uppercase hex (normalised)", () => {
    const m = freshManifest();
    // uppercase the hex portion after 0x
    const upper: SkillManifest = {
      ...m,
      poseidonHash: m.poseidonHash.replace(/^0x/, "0x").toUpperCase().replace("0X", "0x"),
    };
    expect(verifyManifest(upper, SNAPSHOT).poseidonHashValid).toBe(true);
  });

  it("errors contains poseidonHash mismatch message when hash is wrong", () => {
    const m = freshManifest();
    const bad: SkillManifest = { ...m, poseidonHash: "0xdeadbeef" };
    const result = verifyManifest(bad, SNAPSHOT);
    expect(result.errors.some((e) => e.includes("poseidonHash mismatch"))).toBe(true);
  });
});

// ─── tsaAnchorValid ───────────────────────────────────────────────────────────

describe("verifyManifest — tsaAnchorValid", () => {
  it("is false when no tsaToken is present", () => {
    const m = freshManifest();
    expect(m.tsaToken).toBeUndefined();
    expect(verifyManifest(m, SNAPSHOT).tsaAnchorValid).toBe(false);
  });
});

// ─── starknetAnchorValid ──────────────────────────────────────────────────────

describe("verifyManifest — starknetAnchorValid", () => {
  it("is false when no witness is supplied", () => {
    const m = freshManifest();
    expect(verifyManifest(m, SNAPSHOT).starknetAnchorValid).toBe(false);
  });

  it("is false for a witness with type='none'", () => {
    const m = freshManifest();
    const witness: AnchorWitness = {
      type: "none",
      proof: "",
      verifiedAt: new Date(),
    };
    expect(verifyManifest(m, SNAPSHOT, witness).starknetAnchorValid).toBe(false);
  });

  it("is false for a witness with type='tsa' (not a Starknet proof)", () => {
    const m = freshManifest();
    const witness: AnchorWitness = {
      type: "tsa",
      proof: "sometsatoken",
      verifiedAt: new Date(),
    };
    expect(verifyManifest(m, SNAPSHOT, witness).starknetAnchorValid).toBe(false);
  });

  it("is true for a degenerate Starknet tree (empty proof = leaf is root)", () => {
    const m = freshManifest();
    // Empty proof string + type=starknet → degenerate case: leaf is root → valid
    const witness: AnchorWitness = {
      type: "starknet",
      proof: "",
      verifiedAt: new Date(),
    };
    expect(verifyManifest(m, SNAPSHOT, witness).starknetAnchorValid).toBe(true);
  });

  it("is false when Merkle inclusion proof is wrong (bad sibling)", () => {
    const m = freshManifest();
    // A non-empty proof that doesn't actually verify
    const fakeSibling = "a".repeat(64);
    const witness: AnchorWitness = {
      type: "starknet",
      proof: `${fakeSibling},${fakeSibling}`,
      verifiedAt: new Date(),
    };
    const result = verifyManifest(m, SNAPSHOT, witness);
    expect(result.starknetAnchorValid).toBe(false);
  });
});

// ─── valid flag logic ─────────────────────────────────────────────────────────

describe("verifyManifest — valid flag", () => {
  it("valid=true when integrity checks pass (unanchored manifest, no witness)", () => {
    const m = freshManifest();
    // Anchor errors (tsa, starknet, unanchored grade) are non-fatal for valid
    expect(verifyManifest(m, SNAPSHOT).valid).toBe(true);
  });

  it("valid=false when replayRootMatches=false", () => {
    const m = freshManifest();
    const result = verifyManifest(m, "completely different snapshot");
    expect(result.replayRootMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("valid=false when poseidonHashValid=false", () => {
    const m = freshManifest();
    const bad: SkillManifest = { ...m, poseidonHash: "0xbadcafe" };
    const result = verifyManifest(bad, SNAPSHOT);
    expect(result.poseidonHashValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("valid=true even when starknetAnchorValid=false (anchor is non-fatal)", () => {
    const m = freshManifest();
    // No witness → starknetAnchorValid is false, but integrity is intact
    const result = verifyManifest(m, SNAPSHOT);
    expect(result.starknetAnchorValid).toBe(false);
    expect(result.valid).toBe(true);
  });
});

// ─── errors array ─────────────────────────────────────────────────────────────

describe("verifyManifest — errors array", () => {
  it("contains no integrity errors when manifest is valid (only grade warning)", () => {
    const m = freshManifest(); // grade=unanchored → pushes grade warning
    const result = verifyManifest(m, SNAPSHOT);
    const integrityErrors = result.errors.filter(
      (e) => !e.startsWith("tsa") && !e.startsWith("starknet") && !e.startsWith("grade=unanchored"),
    );
    expect(integrityErrors).toHaveLength(0);
  });

  it("contains replayRoot mismatch when snapshot is wrong", () => {
    const m = freshManifest();
    const result = verifyManifest(m, "wrong");
    expect(result.errors.some((e) => e.includes("replayRoot mismatch"))).toBe(true);
  });

  it("contains poseidonHash mismatch when stored hash is wrong", () => {
    const m: SkillManifest = { ...freshManifest(), poseidonHash: "0x1234" };
    const result = verifyManifest(m, SNAPSHOT);
    expect(result.errors.some((e) => e.includes("poseidonHash mismatch"))).toBe(true);
  });

  it("includes grade=unanchored warning for unanchored manifests", () => {
    const m = freshManifest(); // grade=unanchored
    const result = verifyManifest(m, SNAPSHOT);
    expect(result.errors.some((e) => e.startsWith("grade=unanchored"))).toBe(true);
  });

  it("accumulates multiple errors independently (both integrity checks fail)", () => {
    // Break both trainingReplayRoot and poseidonHash
    const m = freshManifest();
    const badRoot = "a".repeat(64);
    const badHash = "0x1111";
    const broken: SkillManifest = {
      ...m,
      trainingReplayRoot: badRoot,
      poseidonHash: badHash,
    };
    const result = verifyManifest(broken, SNAPSHOT);
    expect(result.errors.some((e) => e.includes("replayRoot mismatch"))).toBe(true);
    expect(result.errors.some((e) => e.includes("poseidonHash mismatch"))).toBe(true);
    expect(result.valid).toBe(false);
  });
});

// ─── Attack scenarios ─────────────────────────────────────────────────────────

describe("verifyManifest — attack scenarios", () => {
  it("attacker provides forged trainingReplayRoot with recomputed poseidonHash: check 1 still fails", () => {
    const m = freshManifest();
    const maliciousSnapshot = "malicious payload";
    const forgedRoot = createHash("sha256").update(maliciousSnapshot, "utf8").digest("hex");
    const forgedHash = computeManifestHash({
      skillId: m.skillId,
      version: m.version,
      domain: m.domain,
      trainingReplayRoot: forgedRoot,
    });
    const forged: SkillManifest = {
      ...m,
      trainingReplayRoot: forgedRoot,
      poseidonHash: forgedHash,
    };
    // Verifying against the original snapshot — check 1 must catch the substitution
    const result = verifyManifest(forged, SNAPSHOT);
    expect(result.replayRootMatches).toBe(false);
    expect(result.poseidonHashValid).toBe(true); // hash is self-consistent
    expect(result.valid).toBe(false);
  });
});
