/**
 * ERC-8004-style agent identity (off-chain half) — contract tests.
 *
 * Verifies the `registration.json` builder, the structural validator, the
 * canonical agent id, and the agentWallet ↔ receipt-recipient binding rule.
 */

import { describe, expect, test } from "vitest";
import {
  buildErc8004Registration,
  canonicalAgentId,
  toRegistrationJson,
  validateErc8004Registration,
} from "../../src/registry/erc8004-registration.js";

const VALID_INPUT = {
  type: "agent" as const,
  name: "preste — Command Center",
  description: "Autonomous Vauban agent: provable runs, x402 payments, sandboxed execution.",
  services: [
    {
      type: "mcp" as const,
      url: "https://mcp.vauban.tech",
      description: "MCP server exposing the Command Center surface.",
    },
    {
      type: "x402" as const,
      url: "https://api.vauban.tech/pay",
      description: "Pay-per-call API access.",
      x402Support: { mode: ["DIRECT"] as const, chains: ["starknet:sepolia"] },
    },
  ],
  supportedTrust: ["reputation", "run-certificate"] as const,
  agentWallet: "0xAbC1234567890abcdef1234567890abcdef1234",
};

describe("canonicalAgentId", () => {
  test("builds the eip155 form from chainId + registry address", () => {
    expect(canonicalAgentId("2345", "0x8004A16900000000000000000000000000000001")).toBe(
      "eip155:2345:0x8004A16900000000000000000000000000000001",
    );
  });

  test("rejects a non-numeric chainId", () => {
    expect(() => canonicalAgentId("goat", "0xabc")).toThrow(/chainId must be numeric/);
  });

  test("rejects a non-hex registry address", () => {
    expect(() => canonicalAgentId("2345", "not-an-address")).toThrow(/must be a 0x hex address/);
  });
});

describe("buildErc8004Registration", () => {
  test("produces a valid document with defaults applied", () => {
    const doc = buildErc8004Registration(VALID_INPUT);
    expect(doc.active).toBe(true);
    expect(doc.registrations).toEqual([]);
    expect(doc.metadata).toBeUndefined();
    expect(validateErc8004Registration(doc)).toEqual([]);
  });

  test("keeps explicit active and registrations when provided", () => {
    const doc = buildErc8004Registration({
      ...VALID_INPUT,
      active: false,
      registrations: ["eip155:2345:0x8004A16900000000000000000000000000000001"],
    });
    expect(doc.active).toBe(false);
    expect(doc.registrations).toHaveLength(1);
  });

  test("includes metadata only when non-empty", () => {
    const withMeta = buildErc8004Registration({
      ...VALID_INPUT,
      metadata: { tenant: "vauban" },
    });
    expect(withMeta.metadata).toEqual({ tenant: "vauban" });
  });

  test("throws on a missing agentWallet (fail fast at authoring time)", () => {
    const { agentWallet: _agentWallet, ...missing } = VALID_INPUT;
    expect(() => buildErc8004Registration(missing)).toThrow(/invalid registration document/);
  });

  test("throws when supportedTrust lacks run-certificate", () => {
    expect(() =>
      buildErc8004Registration({ ...VALID_INPUT, supportedTrust: ["reputation"] }),
    ).toThrow(/invalid registration document/);
  });
});

describe("validateErc8004Registration", () => {
  test("returns an empty list for a valid document", () => {
    expect(validateErc8004Registration(buildErc8004Registration(VALID_INPUT))).toEqual([]);
  });

  test("rejects a non-object document", () => {
    expect(validateErc8004Registration(null)).toContain("document must be an object");
    expect(validateErc8004Registration("agent")).toContain("document must be an object");
  });

  test("rejects an unknown service type", () => {
    const bad = buildErc8004Registration(VALID_INPUT);
    (bad.services[0] as { type: string }).type = "ftp";
    const errors = validateErc8004Registration(bad);
    expect(errors.some((e) => e.includes("service type"))).toBe(true);
  });

  test("rejects a non-eip155 registration id", () => {
    const bad = buildErc8004Registration(VALID_INPUT);
    bad.registrations.push("starknet:SN_MAIN:0x1234");
    const errors = validateErc8004Registration(bad);
    expect(errors.some((e) => e.includes("eip155"))).toBe(true);
  });

  test("rejects an unknown supportedTrust value", () => {
    const bad = buildErc8004Registration(VALID_INPUT);
    (bad.supportedTrust as string[]).push("tee-attestation-not-a-thing");
    const errors = validateErc8004Registration(bad);
    expect(errors.some((e) => e.includes("unknown"))).toBe(true);
  });
});

describe("toRegistrationJson", () => {
  test("serializes to pretty-printed JSON with a trailing newline", () => {
    const doc = buildErc8004Registration(VALID_INPUT);
    const json = toRegistrationJson(doc);
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(doc);
  });
});

describe("agentWallet binding rule", () => {
  test("the wallet is carried verbatim so receipts can be matched to identity", () => {
    const doc = buildErc8004Registration(VALID_INPUT);
    expect(doc.agentWallet).toBe(VALID_INPUT.agentWallet);
    // The payment-receipt-chain `recipient` MUST equal this address for a
    // receipt to be verifiable against an identity — enforced by callers.
    expect(doc.agentWallet).toMatch(/^0x[a-fA-F0-9]+$/);
  });
});
