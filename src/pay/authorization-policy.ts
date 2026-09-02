/**
 * PaymentAuthorizationPolicy v1 ; deterministic, signed-able authorization of
 * agent payments, before any money moves.
 *
 * Motivations:
 *   - GOAT's Veridex grant builds "a deterministic authorization layer for
 *     agent payments: policy checks before every payment, ERC-8004 identity,
 *     tamper-evident evidence bundle per transaction." Vauban already owns the
 *     receipt side (payment-receipt-chain: cache, `verify_receipt` cross-check,
 *     claim embedding). This module adds the missing front half: a *policy*
 *     that decides, from facts alone, whether a payment is authorized ; and a
 *     canonical commitment hash that can be embedded in the claim JSON
 *     (`payment_authorization`) today and signed into the Run Certificate
 *     later (the claim signature is outside the signed surface, per
 *     docs/architecture/payment-receipt-chain.md T-09).
 *
 * Rules of the road (mirror the receipt chain discipline):
 *   - amounts are compared as **bigint strings**, never floats
 *     (docs/architecture/payment-receipt-chain.md T-05);
 *   - recipients are compared case-insensitively on the hex form (T-04);
 *   - networks are exact-match strings (T-06);
 *   - the commitment uses the SAME RFC 8785 subset canonicalizer as the Run
 *     Certificate pipeline (`proof/cert-verify.ts`) so a future signer can
 *     fold it into the cert hash without a second grammar.
 *
 * @module pay/authorization-policy
 * @public
 */

import { createHash } from "node:crypto";
import { canonicalizeJcs } from "../proof/cert-verify.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Why a payment is being made. Extend as new paid surfaces appear.
 * @public
 */
export type PaymentPurpose = "skill-install" | "attest" | "api-access" | "tip";

/**
 * The policy an operator/publisher publishes for a paid surface.
 * @public
 */
export interface PaymentPolicy {
  /** Canonical policy id, e.g. `"vauban:marketplace:v1"`. */
  id: string;
  /** Policy version ; bumped when rules change. Part of the commitment. */
  version: number;
  /** Expected recipient address (`0x…`). Compared case-insensitively. */
  recipient: string;
  /** Allowed settlement networks (exact match, e.g. `"sepolia"`, `"starknet:sepolia"`). */
  networks: string[];
  /** Minimum amount in the token's smallest unit. Bigint string ; never float. */
  minAmountWei?: string;
  /** Allowed purposes. When set, a payment with a purpose outside the set is refused. */
  purposes?: PaymentPurpose[];
  /** Maximum age of the payment in ms (anti-stale, mirrors the 1h consume window). */
  maxAgeMs?: number;
}

/**
 * Verifiable facts about the payment being authorized.
 * @public
 */
export interface PaymentFacts {
  /**
   * On-chain transaction hash. OPTIONAL: a pre-payment authorization
   * evaluation (the gate that runs BEFORE any money moves) has no tx yet.
   * Omit it there ; the commitment is computed over the provided facts only
   * (JCS drops undefined), so a post-hoc re-evaluation over the same stable
   * facts (recipient, network, amount, token, purpose, recordedAt) yields the
   * SAME commitment. The tx hash is carried separately in the receipt/claim.
   */
  txHash?: string;
  /** Actual recipient the payment was sent to. */
  recipient: string;
  /** Network the payment settled on. */
  network: string;
  /** Amount paid in smallest unit. Bigint string. */
  amountWei: string;
  /** Token symbol/address if the surface prices in a specific token. */
  token?: string;
  /** Purpose claimed by the caller. */
  purpose?: PaymentPurpose;
  /** ISO timestamp of the payment (for freshness checks). */
  recordedAt?: string;
}

/**
 * Names of the deterministic checks a payment policy can run.
 * @public
 */
export type PolicyCheckName = "recipient" | "network" | "amount" | "purpose" | "freshness";

/**
 * Result of a single policy check.
 * @public
 */
export interface PolicyCheckResult {
  check: PolicyCheckName;
  passed: boolean;
  /** Human-readable explanation (present when `passed === false`). */
  detail?: string;
}

/**
 * Verdict of a payment authorization evaluation.
 * @public
 */
export interface PaymentAuthorizationVerdict {
  /** True when every applicable check passed. */
  authorized: boolean;
  policyId: string;
  policyVersion: number;
  /** Every check that ran, in evaluation order. */
  checks: PolicyCheckResult[];
  /** Names of the checks that failed (empty when authorized). */
  failed: PolicyCheckName[];
  /**
   * SHA-256 (hex) over the JCS-canonicalized `{ policy, facts }` ; the
   * tamper-evident commitment. Same bytes grammar as the cert pipeline.
   */
  commitmentSha256: string;
  /** ISO timestamp of the evaluation. */
  evaluatedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize an address for comparison: lowercase hex without `0x`. */
function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, "");
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Evaluate a payment against a policy, deterministically.
 *
 * Every applicable check runs and is reported; `authorized` is true only when
 * all pass. The function never throws on data problems ; a malformed amount
 * fails the amount check with an explicit detail (fail-closed).
 */
export function evaluatePaymentAuthorization(
  policy: PaymentPolicy,
  facts: PaymentFacts,
): PaymentAuthorizationVerdict {
  const checks: PolicyCheckResult[] = [];

  // recipient (T-04: wrong recipient must fail closed)
  const recipientOk = normalizeAddress(policy.recipient) === normalizeAddress(facts.recipient);
  checks.push({
    check: "recipient",
    passed: recipientOk,
    detail: recipientOk ? undefined : `expected ${policy.recipient}, got ${facts.recipient}`,
  });

  // network (T-06: network mismatch must fail closed)
  const networkOk = policy.networks.includes(facts.network);
  checks.push({
    check: "network",
    passed: networkOk,
    detail: networkOk
      ? undefined
      : `expected one of [${policy.networks.join(", ")}], got ${facts.network}`,
  });

  // amount (T-05: bigint compare, never float) ; only applicable when the
  // policy sets a floor; otherwise the check is not pushed at all.
  if (policy.minAmountWei !== undefined) {
    let amountOk = true;
    let amountDetail: string | undefined;
    try {
      const paid = BigInt(facts.amountWei);
      const min = BigInt(policy.minAmountWei);
      amountOk = paid >= min;
      amountDetail = amountOk
        ? undefined
        : `paid ${facts.amountWei} < minimum ${policy.minAmountWei}`;
    } catch {
      amountOk = false;
      amountDetail = `amountWei "${facts.amountWei}" is not a valid bigint`;
    }
    checks.push({ check: "amount", passed: amountOk, detail: amountDetail });
  }

  // purpose ; only applicable when the policy constrains purposes.
  if (policy.purposes !== undefined) {
    const purposeOk = facts.purpose !== undefined && policy.purposes.includes(facts.purpose);
    checks.push({
      check: "purpose",
      passed: purposeOk,
      detail: purposeOk
        ? undefined
        : `purpose "${facts.purpose ?? "(none)"}" not in [${policy.purposes.join(", ")}]`,
    });
  }

  // freshness (anti-stale; mirrors the 1h consume window in pay-mcp-client.ts).
  // Fail-closed : quand la policy exige la fraicheur (maxAgeMs pose), des facts
  // sans recordedAt ECHOUENT le check au lieu de le sauter ; sinon un paiement
  // sans horodatage serait autorise la ou la policy demande justement d'en
  // borner l'age (revue adverse PR #610, constat MOYENNE).
  if (policy.maxAgeMs !== undefined) {
    if (facts.recordedAt === undefined) {
      checks.push({
        check: "freshness",
        passed: false,
        detail: `policy sets maxAgeMs ${policy.maxAgeMs} but facts carry no recordedAt timestamp`,
      });
    } else {
      const recorded = Date.parse(facts.recordedAt);
      if (Number.isNaN(recorded)) {
        checks.push({
          check: "freshness",
          passed: false,
          detail: `recordedAt "${facts.recordedAt}" is not a valid ISO timestamp`,
        });
      } else {
        const ageMs = Date.now() - recorded;
        const freshOk = ageMs <= policy.maxAgeMs;
        checks.push({
          check: "freshness",
          passed: freshOk,
          detail: freshOk
            ? undefined
            : `payment age ${ageMs}ms exceeds maxAgeMs ${policy.maxAgeMs}`,
        });
      }
    }
  }

  const failed = checks.filter((c) => !c.passed).map((c) => c.check);
  return {
    authorized: failed.length === 0,
    policyId: policy.id,
    policyVersion: policy.version,
    checks,
    failed,
    commitmentSha256: computePaymentAuthorizationCommitment(policy, facts),
    evaluatedAt: new Date().toISOString(),
  };
}

// ─── Commitment ───────────────────────────────────────────────────────────────

/**
 * Compute the canonical payment-authorization commitment: SHA-256 (hex) over
 * the JCS-canonicalized `{ policy, facts }`. Deterministic across processes
 * and languages that implement the same RFC 8785 subset.
 */
export function computePaymentAuthorizationCommitment(
  policy: PaymentPolicy,
  facts: PaymentFacts,
): string {
  const canonical = canonicalizeJcs({ policy, facts } as unknown as Record<string, unknown>);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
