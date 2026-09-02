/**
 * Skill Lineage Manifest — barrel export (sprint-586).
 *
 * @module skill-manifest
 */

export { buildManifest, computeManifestHash } from "./builder.js";
export type { BuildManifestParams } from "./builder.js";
export {
  anchorWithTsa,
  parseTsaToken,
  verifyTsaAnchor,
  anchorWithStarknet,
  TsaUnavailableError,
} from "./anchor.js";
export type { TsaTokenInfo } from "./anchor.js";
export { verifyManifest } from "./verifier.js";
export type { ManifestVerifyResult } from "./verifier.js";
export type { SkillManifest, AnchorWitness } from "./types.js";

// Beyond-Hermes W3-T2 ; signed registry index (TUF-style Ed25519 over a
// SHA-256 Merkle root of skill targets).
export {
  SIGNED_INDEX_SPEC_VERSION,
  UntrustedIndexError,
  assertTarballMatchesIndex,
  buildSignedIndex,
  computeKeyId,
  entryLeafHash,
  findIndexEntry,
  proveEntryInclusion,
  verifyEntryAgainstRoot,
  verifySignedIndex,
} from "./signed-index.js";
export type {
  BuildSignedIndexOptions,
  EntryInclusion,
  IndexVerifyResult,
  SignedSkillIndex,
  SkillIndexEntry,
  UntrustedIndexCode,
} from "./signed-index.js";
