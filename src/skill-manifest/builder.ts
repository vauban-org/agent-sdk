/**
 * Skill Lineage Manifest — builder (sprint-586).
 *
 * Builds an unanchored manifest from raw skill parameters + training replay snapshot.
 * Anchoring (TSA or Starknet) is performed separately in anchor.ts.
 *
 * trainingReplayRoot = SHA-256(replaySnapshot)
 * poseidonHash       = Poseidon(skillId_felt, version_felt, domain_felt, replayRoot_felt)
 *
 * Both computations are deterministic: same inputs → identical hashes every time.
 *
 * @module skill-manifest/builder
 */

import { createHash } from "node:crypto";
import { feltMod, labelToFelt, poseidonHashBigInt } from "../privacy/poseidon-felt252.js";
import type { SkillManifest } from "./types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 of arbitrary bytes or a UTF-8 string.
 * Uses node:crypto synchronously — no async needed for this digest path.
 */
function sha256Hex(input: string | Buffer): string {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Encode a 64-char lowercase hex string as a felt252 BigInt.
 * Reads the first 31 bytes of the 32-byte digest to guarantee felt252-safety
 * (felt252 prime < 2^252, a 31-byte value is always < 2^248 < prime).
 */
function hexToFelt(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Take first 62 hex chars (31 bytes) to stay within felt252 range.
  const safe = clean.slice(0, 62).padEnd(62, "0");
  return feltMod(BigInt(`0x${safe}`));
}

// ─── computeManifestHash ─────────────────────────────────────────────────────

/**
 * Compute the Poseidon commitment over the four manifest fields.
 *
 * Inputs (felt252-encoded):
 *   1. skillId   — labelToFelt (UTF-8 big-endian, 31-byte truncation)
 *   2. version   — labelToFelt
 *   3. domain    — labelToFelt
 *   4. trainingReplayRoot — hexToFelt (first 31 bytes of 32-byte SHA-256)
 *
 * The result is deterministic and ZK-friendly (Poseidon over felt252).
 *
 * @returns Hex string prefixed with "0x" (felt252 canonical form).
 */
export function computeManifestHash(
  manifest: Omit<
    SkillManifest,
    "poseidonHash" | "tsaToken" | "starknetAnchorTx" | "grade" | "ipfsCid" | "createdAt"
  >,
): string {
  const elements: bigint[] = [
    labelToFelt(manifest.skillId),
    labelToFelt(manifest.version),
    labelToFelt(manifest.domain),
    hexToFelt(manifest.trainingReplayRoot),
  ];
  const result = poseidonHashBigInt(elements);
  return `0x${result.toString(16)}`;
}

// ─── buildManifest ────────────────────────────────────────────────────────────

export interface BuildManifestParams {
  skillId: string;
  version: string;
  domain: string;
  /** Raw deterministic training replay trace (bytes or UTF-8 string). */
  replaySnapshot: string | Buffer;
}

/**
 * Build an unanchored SkillManifest from raw skill parameters.
 *
 * Steps:
 *   1. Compute trainingReplayRoot = SHA-256(replaySnapshot).
 *   2. Compute poseidonHash = Poseidon(skillId, version, domain, trainingReplayRoot).
 *   3. Return manifest with grade = 'unanchored'.
 *
 * Anchoring (TSA or Starknet) must be applied separately via anchor.ts.
 */
export function buildManifest(params: BuildManifestParams): SkillManifest {
  const { skillId, version, domain, replaySnapshot } = params;

  // Step 1 — deterministic replay root
  const trainingReplayRoot = sha256Hex(
    typeof replaySnapshot === "string" ? Buffer.from(replaySnapshot, "utf8") : replaySnapshot,
  );

  // Step 2 — Poseidon commitment
  const poseidonHash = computeManifestHash({
    skillId,
    version,
    domain,
    trainingReplayRoot,
  });

  return {
    skillId,
    version,
    domain,
    trainingReplayRoot,
    poseidonHash,
    createdAt: new Date(),
    grade: "unanchored",
  };
}
