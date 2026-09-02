/**
 * tests/signed-index.test.ts ; Beyond-Hermes W3-T2.
 *
 * The TUF-style signed skill registry index: Ed25519 over a SHA-256 Merkle
 * root of the skill targets. Proves the trust properties a regulated buyer
 * asks for ; every tamper class fails CLOSED:
 *   - build -> verify roundtrip (valid) ;
 *   - entry tamper => root-mismatch (the root commits to all entries) ;
 *   - signature tamper / wrong key => bad-signature ; pinned-key mismatch => wrong-key ;
 *   - past expiry => expired ; bad spec => unsupported-spec-version ;
 *   - per-entry Merkle inclusion proof verifies against the signed root ;
 *   - the install gate (assertTarballMatchesIndex) throws sha-mismatch / no-entry.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEd25519Signer, createEd25519Verifier } from "../src/remote/signing.js";
import {
  type SignedSkillIndex,
  type SkillIndexEntry,
  UntrustedIndexError,
  assertTarballMatchesIndex,
  buildSignedIndex,
  computeKeyId,
  entryLeafHash,
  findIndexEntry,
  proveEntryInclusion,
  verifyEntryAgainstRoot,
  verifySignedIndex,
} from "../src/skill-manifest/signed-index.js";

function freshKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    signer: createEd25519Signer(privateKey),
    verify: createEd25519Verifier(publicKey),
    keyId: computeKeyId(publicKey),
  };
}

const ENTRIES: SkillIndexEntry[] = [
  {
    skillId: "cve-summary",
    version: "0.1.0",
    tarballSha256: "a".repeat(64),
    poseidonHash: "0x111",
  },
  {
    skillId: "cve-summary",
    version: "0.2.0",
    tarballSha256: "b".repeat(64),
    poseidonHash: "0x222",
  },
  {
    skillId: "rebalance",
    version: "1.0.0",
    tarballSha256: "c".repeat(64),
    poseidonHash: "0x333",
  },
];

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function buildOk(): {
  index: SignedSkillIndex;
  k: ReturnType<typeof freshKey>;
} {
  const k = freshKey();
  const index = buildSignedIndex(ENTRIES, {
    signer: k.signer,
    keyId: k.keyId,
    version: 1,
    expires: FAR_FUTURE,
  });
  return { index, k };
}

describe("signed-index build + verify", () => {
  it("a freshly built index verifies valid (signature + root + freshness)", () => {
    const { index, k } = buildOk();
    const res = verifySignedIndex(index, k.verify, { expectedKeyId: k.keyId });
    expect(res.valid).toBe(true);
    expect(index.keyId).toBe(k.keyId);
    expect(index.entries).toHaveLength(3);
  });

  it("tampering an entry breaks the root commitment (root-mismatch)", () => {
    const { index, k } = buildOk();
    const bad = structuredClone(index);
    bad.entries[0]!.tarballSha256 = "d".repeat(64);
    const res = verifySignedIndex(bad, k.verify);
    expect(res.valid).toBe(false);
    expect(res.code).toBe("root-mismatch");
  });

  it("tampering the signature fails (bad-signature)", () => {
    const { index, k } = buildOk();
    // Bascule le premier octet vers une valeur GARANTIE différente. Un
    // `.replace(/^../, "00")` aveugle est un non-changement environ une fois
    // sur 256, quand la signature commence déjà par 00 : la falsification
    // passe alors au travers, la vérification réussit légitimement, et ce test
    // échoue pour la mauvaise raison. Le défaut a fait rougir `main` le
    // 2026-08-03. Le même piège avait déjà été trouvé et corrigé dans
    // `memory-provenance.test.ts` ; ce fichier avait gardé le motif aveugle.
    //
    // Un test de sécurité est le pire endroit pour un rouge périodique : il
    // enseigne à relancer plutôt qu'à lire, et le jour où la propriété casse
    // vraiment, le réflexe est déjà installé.
    const firstByte = index.signature.slice(0, 2);
    const forgedFirstByte = firstByte === "00" ? "ff" : "00";
    const bad = { ...index, signature: forgedFirstByte + index.signature.slice(2) };
    expect(verifySignedIndex(bad, k.verify).code).toBe("bad-signature");
  });

  it("a different key fails the signature; pinned keyId mismatch is wrong-key", () => {
    const { index } = buildOk();
    const other = freshKey();
    expect(verifySignedIndex(index, other.verify).code).toBe("bad-signature");
    expect(verifySignedIndex(index, other.verify, { expectedKeyId: other.keyId }).code).toBe(
      "wrong-key",
    );
  });

  it("a past expiry fails (expired)", () => {
    const { index, k } = buildOk();
    const res = verifySignedIndex(index, k.verify, {
      now: new Date("2100-01-01T00:00:00.000Z"),
    });
    expect(res.code).toBe("expired");
  });

  it("an unsupported spec version is rejected", () => {
    const { index, k } = buildOk();
    const bad = { ...index, specVersion: 2 as 1 };
    expect(verifySignedIndex(bad, k.verify).code).toBe("unsupported-spec-version");
  });

  it("rejects duplicate (skillId,version) at build time + non-positive version", () => {
    const k = freshKey();
    expect(() =>
      buildSignedIndex([ENTRIES[0]!, ENTRIES[0]!], {
        signer: k.signer,
        keyId: k.keyId,
        version: 1,
        expires: FAR_FUTURE,
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      buildSignedIndex(ENTRIES, {
        signer: k.signer,
        keyId: k.keyId,
        version: 0,
        expires: FAR_FUTURE,
      }),
    ).toThrow(/version must be/);
  });

  it("an empty index builds + verifies (no entries, sentinel root)", () => {
    const k = freshKey();
    const index = buildSignedIndex([], {
      signer: k.signer,
      keyId: k.keyId,
      version: 1,
      expires: FAR_FUTURE,
    });
    expect(verifySignedIndex(index, k.verify).valid).toBe(true);
  });
});

describe("signed-index lookup + inclusion", () => {
  it("findIndexEntry: exact match, and highest version without one", () => {
    const { index } = buildOk();
    expect(findIndexEntry(index, "cve-summary", "0.1.0")?.tarballSha256).toBe("a".repeat(64));
    // highest version when unspecified: 0.2.0 > 0.1.0
    expect(findIndexEntry(index, "cve-summary")?.version).toBe("0.2.0");
    expect(findIndexEntry(index, "missing")).toBeNull();
  });

  it("a per-entry inclusion proof verifies against the signed root", () => {
    const { index } = buildOk();
    const incl = proveEntryInclusion(index, "rebalance", "1.0.0");
    expect(incl).not.toBeNull();
    expect(incl!.leaf).toBe(entryLeafHash(incl!.entry));
    expect(verifyEntryAgainstRoot(incl!.entry, incl!.proof, incl!.root)).toBe(true);
    // wrong root => false
    expect(verifyEntryAgainstRoot(incl!.entry, incl!.proof, "00".repeat(32))).toBe(false);
  });
});

describe("signed-index install gate (assertTarballMatchesIndex)", () => {
  it("returns the entry when the downloaded sha matches the signed one", () => {
    const { index, k } = buildOk();
    const entry = assertTarballMatchesIndex(
      index,
      {
        skillId: "cve-summary",
        version: "0.1.0",
        tarballSha256: "a".repeat(64),
      },
      k.verify,
      { expectedKeyId: k.keyId },
    );
    expect(entry.version).toBe("0.1.0");
  });

  it("throws sha-mismatch when the downloaded bytes differ from the signed entry", () => {
    const { index, k } = buildOk();
    try {
      assertTarballMatchesIndex(
        index,
        {
          skillId: "cve-summary",
          version: "0.1.0",
          tarballSha256: "f".repeat(64),
        },
        k.verify,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UntrustedIndexError);
      expect((err as UntrustedIndexError).code).toBe("sha-mismatch");
    }
  });

  it("throws no-entry for an unknown skill", () => {
    const { index, k } = buildOk();
    expect(() =>
      assertTarballMatchesIndex(
        index,
        { skillId: "ghost", tarballSha256: "a".repeat(64) },
        k.verify,
      ),
    ).toThrow(UntrustedIndexError);
  });

  it("throws (fail-closed) when the index itself is tampered", () => {
    const { index, k } = buildOk();
    const bad = structuredClone(index);
    bad.entries[0]!.tarballSha256 = "e".repeat(64);
    expect(() =>
      assertTarballMatchesIndex(
        bad,
        {
          skillId: "rebalance",
          version: "1.0.0",
          tarballSha256: "c".repeat(64),
        },
        k.verify,
      ),
    ).toThrow(/root-mismatch/);
  });
});
