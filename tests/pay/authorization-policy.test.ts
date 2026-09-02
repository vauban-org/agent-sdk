/**
 * PaymentAuthorizationPolicy v1 ; contract tests.
 *
 * Covers the deterministic pre-payment decision (recipient / network / amount /
 * purpose / freshness) and the JCS-canonical commitment. Mirrors the
 * payment-receipt-chain discipline: bigint-string amounts, case-insensitive
 * hex recipients, exact-match networks, fail-closed on malformed data.
 */

import { describe, expect, test } from "vitest";
import {
  computePaymentAuthorizationCommitment,
  evaluatePaymentAuthorization,
} from "../../src/pay/authorization-policy.js";

const RECIPIENT = "0xAbC1234567890abcdef1234567890abcdef1234";
const POLICY = {
  id: "vauban:marketplace:v1",
  version: 1,
  recipient: RECIPIENT,
  networks: ["starknet:sepolia"],
  minAmountWei: "1000",
  purposes: ["skill-install", "api-access"],
  maxAgeMs: 3_600_000,
};

const GOOD_FACTS = {
  txHash: "0xdeadbeef",
  recipient: RECIPIENT,
  network: "starknet:sepolia",
  amountWei: "5000",
  purpose: "api-access" as const,
  recordedAt: new Date().toISOString(),
};

describe("evaluatePaymentAuthorization", () => {
  test("authorizes a conforming payment and reports every check", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, GOOD_FACTS);
    expect(verdict.authorized).toBe(true);
    expect(verdict.failed).toEqual([]);
    expect(verdict.checks.map((c) => c.check)).toEqual([
      "recipient",
      "network",
      "amount",
      "purpose",
      "freshness",
    ]);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
    expect(verdict.policyId).toBe("vauban:marketplace:v1");
    expect(verdict.policyVersion).toBe(1);
  });

  test("fails closed on recipient mismatch (T-04)", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      recipient: "0x9999999999999999999999999999999999999999",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("recipient");
  });

  test("compares recipients case-insensitively on the hex form", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      recipient: RECIPIENT.toUpperCase(),
    });
    expect(verdict.authorized).toBe(true);
  });

  test("fails closed on network mismatch (T-06)", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      network: "ethereum:mainnet",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("network");
  });

  test("fails closed when amount is below the minimum (T-05)", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      amountWei: "999",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("amount");
  });

  test("fails closed on a malformed amount instead of throwing", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      amountWei: "not-a-number",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("amount");
    const amountCheck = verdict.checks.find((c) => c.check === "amount");
    expect(amountCheck?.detail).toMatch(/not a valid bigint/);
  });

  test("fails closed when purpose is outside the allowed set", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      purpose: "tip",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("purpose");
  });

  test("skips the purpose check when the policy does not constrain purposes", () => {
    const { purposes: _purposes, ...openPolicy } = POLICY;
    const verdict = evaluatePaymentAuthorization(openPolicy, GOOD_FACTS);
    expect(verdict.authorized).toBe(true);
    expect(verdict.checks.some((c) => c.check === "purpose")).toBe(false);
  });

  test("fails freshness for a stale payment beyond maxAgeMs", () => {
    const stale = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      recordedAt: stale,
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("freshness");
  });

  test("fails freshness on an unparseable timestamp", () => {
    const verdict = evaluatePaymentAuthorization(POLICY, {
      ...GOOD_FACTS,
      recordedAt: "yesterday-ish",
    });
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("freshness");
  });

  test("fails closed when the policy demands freshness but facts lack recordedAt", () => {
    const { recordedAt: _recordedAt, ...factsWithoutTimestamp } = GOOD_FACTS;
    const verdict = evaluatePaymentAuthorization(POLICY, factsWithoutTimestamp);
    expect(verdict.authorized).toBe(false);
    expect(verdict.failed).toContain("freshness");
    const freshnessCheck = verdict.checks.find((c) => c.check === "freshness");
    expect(freshnessCheck?.detail).toMatch(/no recordedAt timestamp/);
  });

  test("skips the freshness check when maxAgeMs is unset", () => {
    const { maxAgeMs: _maxAgeMs, ...openPolicy } = POLICY;
    const verdict = evaluatePaymentAuthorization(openPolicy, GOOD_FACTS);
    expect(verdict.authorized).toBe(true);
    expect(verdict.checks.some((c) => c.check === "freshness")).toBe(false);
  });

  test("skips the amount check when minAmountWei is unset", () => {
    const { minAmountWei: _minAmountWei, ...openPolicy } = POLICY;
    const verdict = evaluatePaymentAuthorization(openPolicy, {
      ...GOOD_FACTS,
      amountWei: "0",
    });
    expect(verdict.authorized).toBe(true);
    expect(verdict.checks.some((c) => c.check === "amount")).toBe(false);
  });
});

describe("computePaymentAuthorizationCommitment", () => {
  test("is deterministic across calls with equal inputs", () => {
    const a = computePaymentAuthorizationCommitment(POLICY, GOOD_FACTS);
    const b = computePaymentAuthorizationCommitment(POLICY, GOOD_FACTS);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when a fact changes (tamper evidence)", () => {
    const base = computePaymentAuthorizationCommitment(POLICY, GOOD_FACTS);
    const tampered = computePaymentAuthorizationCommitment(POLICY, {
      ...GOOD_FACTS,
      amountWei: "5001",
    });
    expect(tampered).not.toBe(base);
  });

  test("is canonical: key order does not change the commitment", () => {
    // Rebuild the same facts object with keys inserted in a different order.
    const shuffled: typeof GOOD_FACTS = {
      purpose: GOOD_FACTS.purpose,
      recordedAt: GOOD_FACTS.recordedAt,
      network: GOOD_FACTS.network,
      amountWei: GOOD_FACTS.amountWei,
      recipient: GOOD_FACTS.recipient,
      txHash: GOOD_FACTS.txHash,
    };
    const base = computePaymentAuthorizationCommitment(POLICY, GOOD_FACTS);
    const reordered = computePaymentAuthorizationCommitment(POLICY, shuffled);
    expect(reordered).toBe(base);
  });
});
