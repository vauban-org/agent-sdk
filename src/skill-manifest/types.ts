/**
 * Skill Lineage Manifest — types (sprint-586).
 *
 * Every skill has a cryptographically anchored lineage.
 * Modifying 1 byte of the training replay → verifier rejects.
 * ClawHavoc defense: arXiv:2603.00195.
 *
 * Grade hierarchy:
 *   starknet_primary — Poseidon hash anchored on-chain (decentralised, post-quantum).
 *   tsa_fallback     — RFC 3161 DigiCert TSA only (DEGRADED: centralised, not post-quantum).
 *   unanchored       — Development / testing only. No anchor.
 *
 * @module skill-manifest/types
 */

// ─── SkillManifest ────────────────────────────────────────────────────────────

export interface SkillManifest {
  /** Canonical identifier for the skill, e.g. "vauban.sentinel.rebalancing". */
  skillId: string;
  /** SemVer of the skill implementation. */
  version: string;
  /** Domain bucket, e.g. "finance", "governance", "identity". */
  domain: string;
  /**
   * SHA-256 hex digest of the deterministic training replay snapshot.
   * 1-byte tamper in the replay → this value changes → verifier rejects.
   */
  trainingReplayRoot: string;
  /**
   * Poseidon(skillId_felt, version_felt, domain_felt, replayRoot_felt).
   * ZK-friendly commitment over felt252 — used for Starknet anchoring.
   */
  poseidonHash: string;
  /**
   * Base64-encoded RFC 3161 TimeStampToken from DigiCert TSA.
   * Fallback anchor only — see grade field for semantics.
   */
  tsaToken?: string;
  /**
   * Starknet transaction hash of the batch anchor call.
   * Present when grade === 'starknet_primary'.
   */
  starknetAnchorTx?: string;
  /**
   * Optional IPFS CID of the full manifest for content-addressed redundancy.
   * Not a security anchor — informational only.
   */
  ipfsCid?: string;
  createdAt: Date;
  /**
   * Proof grade of this manifest:
   *   starknet_primary — on-chain, decentralised, post-quantum (Poseidon/STARK).
   *   tsa_fallback     — RFC 3161 DigiCert TSA only — DEGRADED MODE.
   *   unanchored       — No anchor. Development/testing only.
   */
  grade: "starknet_primary" | "tsa_fallback" | "unanchored";
}

// ─── AnchorWitness ────────────────────────────────────────────────────────────

export interface AnchorWitness {
  /** Which anchor mechanism produced this witness. */
  type: "starknet" | "tsa" | "none";
  /**
   * For starknet: Merkle inclusion proof (hex-encoded siblings, comma-separated).
   * For tsa: base64 TSA token (same as SkillManifest.tsaToken).
   * For none: empty string.
   */
  proof: string;
  verifiedAt: Date;
}
