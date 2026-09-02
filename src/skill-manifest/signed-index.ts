/**
 * Signed skill registry index ; Beyond-Hermes W3-T2.
 *
 * Hermes / OpenClaw skill registries have a per-tarball hash but NO signed,
 * versioned index over the whole registry: a registry operator (or anyone who
 * compromises the host) can swap a tarball AND its advertised hash and the
 * client cannot tell (the Postmark Sept-2025 supply-chain class ; signing
 * proves build, not behaviour). This is the TUF-style countermeasure:
 *
 *   - every target (skill tarball) is committed to a SHA-256 Merkle root over
 *     the canonical entry leaves {skillId, version, tarballSha256, poseidonHash} ;
 *   - the ROOT (not each leaf) is Ed25519-signed by an offline operator key
 *     (`createEd25519Signer`), TUF-fashion ; the signature also covers a
 *     monotonic `version` (rollback protection) and an `expires` (freshness) ;
 *   - a client verifies the signature against a PINNED public key, recomputes
 *     the root from the entries, then cross-checks a downloaded tarball's actual
 *     SHA-256 against the signed entry. Any tamper (entry, root, signature,
 *     expiry, key, or tarball bytes) fails CLOSED with `UntrustedIndexError`.
 *
 * The Merkle layer reuses the proof-core SHA-256 trio
 * (`computeSha256MerkleRoot` / `computeSha256InclusionProof` /
 * `verifySha256InclusionProof`) so build and verify share ONE convention
 * (sorted-pair, power-of-2 zero-padding) ; no hand-rolled crypto, no
 * cross-impl verification. `proveEntryInclusion` lets a thin client verify a
 * single entry against the signed root without the full entry list.
 *
 * Key custody: the signing key lives on an operator workstation ONLY, never on
 * the Vera headless pod (signing is an offline publish step). `anchorWithStarknet`
 * remains a dev stub ; the Ed25519 signature is the real trust artifact here.
 *
 * @public @since beyond-hermes-wave3
 * Ref: command-center:beyond-hermes:w3-t2
 */

import { type KeyObject, createHash } from "node:crypto";
import {
  computeSha256InclusionProof,
  computeSha256MerkleRoot,
  verifySha256InclusionProof,
} from "@vauban-org/proof-core";
import { canonicalize } from "json-canonicalize";
import type { SignFn, VerifyFn } from "../remote/signing.js";

/**
 * Index document format version (TUF `spec_version` analog).
 * @public
 */
export const SIGNED_INDEX_SPEC_VERSION = 1 as const;

/** Merkle root of an index with zero entries (domain-separated sentinel). */
const EMPTY_ROOT = createHash("sha256").update("vauban:signed-skill-index:empty").digest("hex");

/**
 * One target in the registry.
 * @public
 */
export interface SkillIndexEntry {
  /** Canonical skill id / slug. */
  skillId: string;
  /** Skill SemVer. */
  version: string;
  /** SHA-256 (hex) of the distributed tarball ; the bytes the client checks. */
  tarballSha256: string;
  /** Poseidon commitment from the skill's lineage manifest (ZK-friendly). */
  poseidonHash: string;
}

/**
 * A signed, versioned registry index.
 * @public
 */
export interface SignedSkillIndex {
  specVersion: typeof SIGNED_INDEX_SPEC_VERSION;
  /** Monotonic index version ; a client rejects an older version (TUF rollback). */
  version: number;
  /** ISO-8601 expiry ; a client rejects a stale index (TUF freshness). */
  expires: string;
  /** Targets. Order-independent (the root sorts leaves). */
  entries: SkillIndexEntry[];
  /** SHA-256 Merkle root over the entry leaves. */
  root: string;
  /** SHA-256 (hex) of the signing public key SPKI/DER ; which key signed. */
  keyId: string;
  /** Ed25519 (hex) over the canonical signed core (see `signedCore`). */
  signature: string;
}

/**
 * Machine-readable rejection reasons (also `UntrustedIndexError.code`).
 * @public
 */
export type UntrustedIndexCode =
  | "unsupported-spec-version"
  | "wrong-key"
  | "root-mismatch"
  | "bad-signature"
  | "expired"
  | "no-entry"
  | "sha-mismatch";

/** @public */
export interface IndexVerifyResult {
  valid: boolean;
  code?: UntrustedIndexCode;
  detail?: string;
}

/**
 * Thrown by the fail-closed install gate (`assertTarballMatchesIndex`).
 * @public
 */
export class UntrustedIndexError extends Error {
  readonly code: UntrustedIndexCode;
  constructor(code: UntrustedIndexCode, message?: string) {
    super(message ?? code);
    this.name = "UntrustedIndexError";
    this.code = code;
  }
}

// ─── leaf + core canonicalization ─────────────────────────────────────────────

/**
 * Canonical leaf hash for an entry (SHA-256 over RFC-8785 canonical JSON).
 * Hex fields are lower-cased so a case-only difference cannot fork the leaf.
 * @public
 */
export function entryLeafHash(entry: SkillIndexEntry): string {
  const canon = canonicalize({
    skillId: entry.skillId,
    version: entry.version,
    tarballSha256: entry.tarballSha256.toLowerCase(),
    poseidonHash: entry.poseidonHash.toLowerCase(),
  });
  return createHash("sha256").update(canon, "utf-8").digest("hex");
}

function rootOf(entries: SkillIndexEntry[]): string {
  if (entries.length === 0) return EMPTY_ROOT;
  return computeSha256MerkleRoot(entries.map(entryLeafHash));
}

/** The exact bytes the Ed25519 signature covers (signature field excluded). */
function signedCore(i: {
  specVersion: number;
  version: number;
  expires: string;
  root: string;
  keyId: string;
}): string {
  return canonicalize({
    specVersion: i.specVersion,
    version: i.version,
    expires: i.expires,
    root: i.root,
    keyId: i.keyId,
  });
}

/**
 * SHA-256 (hex) of a public key's SPKI/DER ; the stable `keyId`.
 * @public
 */
export function computeKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

// ─── build ─────────────────────────────────────────────────────────────────────

/** @public */
export interface BuildSignedIndexOptions {
  /** Ed25519 signer (operator key) ; see `createEd25519Signer`. */
  signer: SignFn;
  /** `computeKeyId(publicKey)` of the signer's key. */
  keyId: string;
  /** Monotonic index version (>= 1). */
  version: number;
  /** ISO-8601 expiry. */
  expires: string;
}

/**
 * Build a signed index over `entries`. Rejects duplicate (skillId, version)
 * pairs (an ambiguous registry is a trust hazard).
 * @public
 */
export function buildSignedIndex(
  entries: SkillIndexEntry[],
  opts: BuildSignedIndexOptions,
): SignedSkillIndex {
  if (!Number.isInteger(opts.version) || opts.version < 1) {
    throw new Error("buildSignedIndex: version must be an integer >= 1");
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.skillId}@${e.version}`;
    if (seen.has(key)) {
      throw new Error(`buildSignedIndex: duplicate entry ${key}`);
    }
    seen.add(key);
  }
  const root = rootOf(entries);
  const core = {
    specVersion: SIGNED_INDEX_SPEC_VERSION,
    version: opts.version,
    expires: opts.expires,
    root,
    keyId: opts.keyId,
  };
  return { ...core, entries, signature: opts.signer(signedCore(core)) };
}

// ─── verify ──────────────────────────────────────────────────────────────────

/**
 * Verify a signed index against a public-key `verify` fn. Checks, in order:
 * spec version, optional pinned-key match, entry->root commitment, Ed25519
 * signature, and freshness. `now` + `expectedKeyId` are injectable.
 * @public
 */
export function verifySignedIndex(
  index: SignedSkillIndex,
  verify: VerifyFn,
  opts: { now?: Date; expectedKeyId?: string } = {},
): IndexVerifyResult {
  if (index.specVersion !== SIGNED_INDEX_SPEC_VERSION) {
    return {
      valid: false,
      code: "unsupported-spec-version",
      detail: String(index.specVersion),
    };
  }
  if (opts.expectedKeyId && index.keyId !== opts.expectedKeyId) {
    return { valid: false, code: "wrong-key", detail: index.keyId };
  }
  if (rootOf(index.entries) !== index.root) {
    return { valid: false, code: "root-mismatch" };
  }
  let sigOk = false;
  try {
    sigOk = verify(signedCore(index), index.signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false, code: "bad-signature" };

  const expiresMs = Date.parse(index.expires);
  const nowMs = (opts.now ?? new Date()).getTime();
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    return { valid: false, code: "expired", detail: index.expires };
  }
  return { valid: true };
}

// ─── lookup + inclusion ────────────────────────────────────────────────────────

function compareDottedDesc(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  }
  return b.localeCompare(a);
}

/**
 * Find an entry by skillId. With `version`, an exact match ; without, the
 * highest version present. Returns null when absent.
 * @public
 */
export function findIndexEntry(
  index: SignedSkillIndex,
  skillId: string,
  version?: string,
): SkillIndexEntry | null {
  const matches = index.entries.filter(
    (e) => e.skillId === skillId && (version === undefined || e.version === version),
  );
  if (matches.length === 0) return null;
  if (version !== undefined) return matches[0] ?? null;
  return [...matches].sort((a, b) => compareDottedDesc(a.version, b.version))[0] ?? null;
}

/** @public */
export interface EntryInclusion {
  entry: SkillIndexEntry;
  leaf: string;
  proof: string[];
  root: string;
}

/**
 * Produce a Merkle inclusion proof for one entry, so a thin client can verify
 * it against a trusted root WITHOUT the full entry list. Reuses the proof-core
 * SHA-256 proof generator (which sorts leaves internally, hence the
 * sorted-index lookup). Returns null when the skill is absent.
 * @public
 */
export function proveEntryInclusion(
  index: SignedSkillIndex,
  skillId: string,
  version?: string,
): EntryInclusion | null {
  const entry = findIndexEntry(index, skillId, version);
  if (!entry) return null;
  const leaves = index.entries.map(entryLeafHash);
  const leaf = entryLeafHash(entry);
  const sortedIdx = [...leaves].sort().indexOf(leaf);
  const proof = computeSha256InclusionProof(leaves, sortedIdx);
  return { entry, leaf, proof, root: index.root };
}

/**
 * Verify an entry belongs to `root` via its inclusion proof (proof-core trio).
 * @public
 */
export function verifyEntryAgainstRoot(
  entry: SkillIndexEntry,
  proof: string[],
  root: string,
): boolean {
  return verifySha256InclusionProof(entryLeafHash(entry), proof, root);
}

// ─── install-time fail-closed gate ─────────────────────────────────────────────

/**
 * The supply-chain gate: verify the signed index, locate the target entry, and
 * assert the DOWNLOADED tarball's actual SHA-256 equals the signed one. Throws
 * `UntrustedIndexError` on any failure (fail-closed) ; returns the matched
 * entry on success.
 * @public
 */
export function assertTarballMatchesIndex(
  index: SignedSkillIndex,
  target: { skillId: string; version?: string; tarballSha256: string },
  verify: VerifyFn,
  opts: { now?: Date; expectedKeyId?: string } = {},
): SkillIndexEntry {
  const res = verifySignedIndex(index, verify, opts);
  if (!res.valid) {
    throw new UntrustedIndexError(
      res.code ?? "bad-signature",
      `signed index rejected (${res.code}${res.detail ? `: ${res.detail}` : ""})`,
    );
  }
  const entry = findIndexEntry(index, target.skillId, target.version);
  if (!entry) {
    throw new UntrustedIndexError(
      "no-entry",
      `no signed entry for ${target.skillId}${target.version ? `@${target.version}` : ""}`,
    );
  }
  if (entry.tarballSha256.toLowerCase() !== target.tarballSha256.toLowerCase()) {
    throw new UntrustedIndexError(
      "sha-mismatch",
      `tarball sha256 ${target.tarballSha256} != signed ${entry.tarballSha256} for ${entry.skillId}@${entry.version}`,
    );
  }
  return entry;
}
