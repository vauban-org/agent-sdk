/**
 * remote/proof-export — turn an attestation Trace into a publicly shareable
 * proof claim (T6e).
 *
 * The full Trace is verbose and may carry redacted payloads — it is not a
 * great thing to drop into a tweet or a pitch deck. A ProofClaim is the
 * compact, self-contained extract: who, what, when, how many steps, and
 * the Merkle root that anchors the claim to the underlying trace. It is
 * Ed25519-signed by the exporter (typically the agent's own attestation
 * key) so a verifier with the exporter's public key can recompute and
 * confirm without ever seeing the Trace.
 *
 * Cross-check is optional but encouraged: when both the claim and the
 * source trace bytes are available, the verifier should also confirm that
 * `sha256(traceBytes) === claim.traceSha256` so the claim cannot be reused
 * to vouch for a different run.
 *
 * @public @since 2.16.0 — preste remote-control T6e (attested proof export)
 */

import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { Trace } from "../trace/schema.js";
import type { SignFn, VerifyFn } from "./signing.js";

/** Stable schema version of the proof-claim format. */
export const PROOF_CLAIM_VERSION = "1" as const;

/** Optional TSA receipt mirrored from the underlying Trace. */
export interface ProofReceipt {
  tsa: string;
  timestamp: string;
  signature: string;
  algorithm: string;
  hashedMessage: string;
}

/**
 * Optional embedded payment receipt (P10) — proves the run was paid for.
 *
 * Built around the zkpay Stwo-proven Starknet settlement primitive but
 * intentionally chain-agnostic at the type level (per ADR-ECO-031) :
 * `network` is the operative discriminator, anything Starknet-specific
 * lives in `proofCommitment` (Stwo) and the adapter that produced it.
 *
 * Phase MVP (Q4 2026) : Sepolia POC only. Mainnet gates on audit per
 * ADR-ECO-022 v2 §10 K6.
 *
 * @public @since 2.23.0 — preste P10 Sepolia POC schema bump
 */
export interface SettlementReceipt {
  /**
   * Settlement chain / network identifier.
   *   - `starknet-sepolia` (Phase MVP)
   *   - `starknet-mainnet` (post-audit, Phase 5+)
   *   - reserved : `evm-sepolia`, `solana-devnet`, `bitcoin-signet`
   */
  network: string;
  /** Settlement transaction hash on the network. */
  txHash: string;
  /** Block / slot number where the settlement landed. */
  blockNumber: number;
  /** ISO 8601 block-inclusion timestamp. */
  blockTime: string;
  /**
   * Amount paid, in the token's smallest unit (e.g. wei equivalent).
   * String for safe handling of u256 ; consumers convert to bigint /
   * Decimal as needed.
   */
  amount: string;
  /** Token contract address (or chain-native marker like "STRK20"). */
  token: string;
  /** Token decimals — for display formatting only ; never authoritative. */
  decimals: number;
  /** Recipient address (the agent's beneficiary). */
  to: string;
  /** Payer address. */
  from: string;
  /**
   * Optional cryptographic commitment from the underlying proof system
   * (e.g. Stwo proof hash for zkpay). Opaque blob — verifier-specific.
   */
  proofCommitment?: string;
  /**
   * Optional URL to fetch the full proof artefact (for offline replay /
   * verifier audit). The proof itself is NOT inlined — it can be large.
   */
  proofUrl?: string;
}

/**
 * Optional embedded payment authorization — the deterministic policy verdict
 * that ran BEFORE the settlement moved (the Veridex-shaped front half of the
 * payment-receipt-chain).
 *
 * When present alongside `paymentReceipt`, the claim proves not only that the
 * run was paid for, but that the payment was AUTHORIZED by policy before any
 * money moved. `commitmentSha256` is the SHA-256 over the JCS-canonicalized
 * `{ policy, facts }` (same RFC 8785 subset grammar as the Run Certificate
 * pipeline — see `proof/cert-verify.ts`), so a verifier can recompute it from
 * the published policy and the payment facts. It is part of the signed surface.
 *
 * @public @since 2.31.0 — payment authorization policy v1 in the claim
 */
export interface PaymentAuthorization {
  /** Canonical policy id (e.g. `"vauban:marketplace:v1"`). */
  policyId: string;
  /** Policy version at evaluation time. */
  policyVersion: number;
  /** SHA-256 (hex) over JCS-canonicalized `{ policy, facts }`. */
  commitmentSha256: string;
  /** ISO timestamp of the evaluation. */
  evaluatedAt: string;
  /** True when the payment was authorized (fail-closed denies never persist). */
  authorized: boolean;
}

/**
 * The publicly shareable proof artefact. Compact (≈1 KB), self-contained,
 * Ed25519-signable, and pinned to the source Trace via `traceSha256`.
 * @public
 */
export interface ProofClaim {
  readonly type: "preste-proof-claim";
  readonly version: typeof PROOF_CLAIM_VERSION;
  /** The runId from the underlying Trace. */
  runId: string;
  /** Agent identity at the time of the run. */
  agent: { id: string; version: string };
  /** What the agent was asked to do (from `trace.config.task` when present). */
  task?: string;
  /** Terminal status (mirrors `trace.status`). */
  status: Trace["status"];
  /** Step count (mirrors `trace.totalSteps`). */
  stepCount: number;
  /** Start time (ISO 8601). */
  startedAt: string;
  /** Completion time (ISO 8601). */
  completedAt: string;
  /** Merkle root of the step chain (mirrors `trace.rootHash`). */
  rootHash: string;
  /** Agent-level signature over `rootHash` if the Trace carried one. */
  agentSignature?: string;
  /** TSA receipt mirrored from the Trace, when external timestamping ran. */
  receipt?: ProofReceipt;
  /**
   * SHA-256 of the source trace bytes (hex). Anchors the claim to the
   * exact JSON it was extracted from, so the claim cannot be re-used to
   * vouch for a different run.
   */
  traceSha256: string;
  /** ISO 8601 time the claim was minted. */
  exportedAt: string;
  /**
   * Optional embedded payment receipt — proves the run was paid for via
   * a settlement primitive (zkpay Stwo on Starknet for Phase MVP). When
   * present, the claim doubles as a regulatory-grade receipt linking
   * the work product to its settlement transaction. (P10)
   */
  paymentReceipt?: SettlementReceipt;
  /**
   * Optional embedded payment authorization — the policy verdict that ran
   * BEFORE the payment was submitted (when the payer enforced a policy).
   * Signed with the rest of the claim: tampering with it post-hoc breaks
   * `claimSignature`.
   */
  paymentAuthorization?: PaymentAuthorization;
  /** Ed25519 signature over `canonicalize(claim minus claimSignature)` (hex). */
  claimSignature?: string;
}

/** Compute the hex SHA-256 of a UTF-8 string — used for `traceSha256`. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Claim fields written ALONGSIDE the signed claim but intentionally NOT part
 * of the signed surface. `preste attest claim` auto-embed writes the Pay MCP
 * cross-check result under `payment_receipt` (snake_case) AFTER signing ;
 * sign-time and verify-time MUST both exclude these keys from the canonical
 * bytes so auto-embedded claims stay verifiable.
 *
 * @internal — do not add signed fields here.
 */
const UNSIGNED_CLAIM_METADATA_KEYS = ["payment_receipt"] as const;

/** The bytes that get signed. Same shape as the claim, sans `claimSignature`. */
export function canonicalClaimString(claim: ProofClaim): string {
  const { claimSignature: _omitted, ...rest } = claim;
  // Drop known unsigned metadata so a claim that was written with the
  // auto-embed `payment_receipt` field still canonicalizes to the same bytes
  // that were signed at export time.
  for (const key of UNSIGNED_CLAIM_METADATA_KEYS) {
    delete (rest as Record<string, unknown>)[key];
  }
  return canonicalize(rest);
}

/**
 * Options for `exportProofClaim` — extends the original 3-arg signature.
 * @public
 */
export interface ExportProofClaimOptions {
  /**
   * Optional settlement receipt to embed in the claim. When supplied,
   * the receipt is signed AS PART OF the claim (its bytes flow into
   * canonicalClaimString → claimSignature). Tampering with the receipt
   * post-hoc breaks the signature. (P10)
   */
  paymentReceipt?: SettlementReceipt;
  /**
   * Optional payment authorization verdict to embed alongside the receipt.
   * When supplied, it is signed AS PART OF the claim — the claim then proves
   * the run was paid for AND that the payment was policy-authorized before
   * any money moved. (PaymentAuthorizationPolicy v1)
   */
  paymentAuthorization?: PaymentAuthorization;
}

/**
 * Build a ProofClaim from a Trace and the exact bytes the Trace was loaded
 * from. Pass `signClaim` to seal the claim with the exporter's Ed25519 key.
 *
 * `opts.paymentReceipt` embeds a settlement receipt — when present, the
 * resulting claim is a single signed artefact that links the agent's work
 * to its payment transaction. The receipt is part of the signed surface,
 * so any tampering post-sign invalidates the claim.
 * @public
 */
export function exportProofClaim(
  trace: Trace,
  traceBytes: string,
  signClaim?: SignFn,
  opts: ExportProofClaimOptions = {},
): ProofClaim {
  const task =
    typeof trace.config.task === "string" && trace.config.task.trim()
      ? (trace.config.task as string).trim()
      : undefined;

  const base: ProofClaim = {
    type: "preste-proof-claim",
    version: PROOF_CLAIM_VERSION,
    runId: trace.runId,
    agent: { id: trace.agentId, version: trace.agentVersion },
    ...(task ? { task } : {}),
    status: trace.status,
    stepCount: trace.totalSteps,
    startedAt: new Date(trace.startedAt).toISOString(),
    completedAt: new Date(trace.completedAt).toISOString(),
    rootHash: trace.rootHash,
    ...(trace.agentSignature ? { agentSignature: trace.agentSignature } : {}),
    ...(trace.receipt
      ? {
          receipt: {
            tsa: trace.receipt.tsa,
            timestamp: trace.receipt.timestamp,
            signature: trace.receipt.signature,
            algorithm: trace.receipt.algorithm,
            hashedMessage: trace.receipt.hashedMessage,
          },
        }
      : {}),
    traceSha256: sha256Hex(traceBytes),
    exportedAt: new Date().toISOString(),
    ...(opts.paymentReceipt ? { paymentReceipt: opts.paymentReceipt } : {}),
    ...(opts.paymentAuthorization ? { paymentAuthorization: opts.paymentAuthorization } : {}),
  };

  if (!signClaim) return base;
  const sig = signClaim(canonicalClaimString(base));
  return { ...base, claimSignature: sig };
}

/**
 * Late-bind a `paymentReceipt` to an existing claim and re-sign. Use this
 * when settlement happens AFTER the agent run finishes — the original
 * claim was exported unpaid, payment lands later, and the verifier wants
 * both the run attestation AND the settlement receipt in one artefact.
 *
 * @param claim       The original (signed or unsigned) claim.
 * @param receipt     The settlement receipt to embed.
 * @param signClaim   Optional re-sign function ; omit to leave the claim
 *                    unsigned (the verifier can still cross-check the
 *                    receipt against the chain itself).
 *
 * @public @since 2.23.0 — preste P10 settlement receipt embedding
 */
export function withPaymentReceipt(
  claim: ProofClaim,
  receipt: SettlementReceipt,
  signClaim?: SignFn,
): ProofClaim {
  // Drop the prior signature ; the surface is changing.
  const { claimSignature: _omit, ...rest } = claim;
  const updated: ProofClaim = { ...rest, paymentReceipt: receipt };
  if (!signClaim) return updated;
  const sig = signClaim(canonicalClaimString(updated));
  return { ...updated, claimSignature: sig };
}

/**
 * Result of verifying a proof claim.
 * @public
 */
export interface ProofClaimVerification {
  valid: boolean;
  /** Empty when `valid` is true; otherwise lists every failure. */
  reasons: string[];
}

/**
 * Verify a ProofClaim. Required: the exporter's verify function. Optional:
 * the source trace bytes — when provided, the verifier also recomputes
 * `sha256(traceBytes)` and compares against `claim.traceSha256`, so a claim
 * cannot be reused to vouch for a different Trace.
 *
 * Returns `{valid, reasons[]}`; every failure is recorded so the caller can
 * surface a useful error rather than a binary yes/no.
 * @public
 */
export function verifyProofClaim(
  claim: ProofClaim,
  verifyClaim: VerifyFn,
  traceBytes?: string,
): ProofClaimVerification {
  const reasons: string[] = [];

  if (claim.type !== "preste-proof-claim") {
    reasons.push(`unknown type: ${String(claim.type)}`);
  }
  if (claim.version !== PROOF_CLAIM_VERSION) {
    reasons.push(`unsupported version: ${String(claim.version)}`);
  }
  if (!claim.claimSignature) {
    reasons.push("missing claimSignature");
  } else {
    let signatureOk = false;
    try {
      signatureOk = verifyClaim(canonicalClaimString(claim), claim.claimSignature);
    } catch (err) {
      reasons.push(`signature check threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!signatureOk) reasons.push("claim signature does not verify");
  }

  if (traceBytes !== undefined) {
    const recomputed = sha256Hex(traceBytes);
    if (recomputed !== claim.traceSha256) {
      reasons.push(`traceSha256 mismatch: claim=${claim.traceSha256} actual=${recomputed}`);
    }
  }

  return { valid: reasons.length === 0, reasons };
}
