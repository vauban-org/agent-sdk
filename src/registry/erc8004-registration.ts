/**
 * ERC-8004-style agent identity — `registration.json` builder and validator.
 *
 * EIP-8004 (draft; MetaMask/EF/Google/Coinbase sponsorship) defines an
 * on-chain agent identity + reputation registry and a machine-readable
 * `registration.json` document that describes an agent: its services
 * (A2A, MCP, x402…), its payment wallet, and the trust mechanisms it
 * supports. GOAT Network (chain 2345) is the reference implementation.
 *
 * Vauban does not (yet) deploy an on-chain identity registry on Starknet.
 * This module therefore produces the **off-chain half** of the standard —
 * a valid, spec-shaped `registration.json` that any ERC-8004 reader can
 * ingest — with two Vauban-native extensions kept out of the reserved
 * fields:
 *
 *   - `agentWallet`  — the payment wallet (EIP-8004 `get_agent_wallet`),
 *     wired to the payment-receipt-chain `recipient` so that "who do I pay
 *     for this agent" and "who does the receipt prove I paid" are the same
 *     address (see docs/architecture/payment-receipt-chain.md).
 *   - `supportedTrust` — the standard values (`"reputation"`,
 *     `"tee-attestation"`) plus `"run-certificate"`, the Vauban-specific
 *     trust mechanism: each run is provable via a signed Run Certificate
 *     (Ed25519 + Poseidon, see `proof/cert-verify.ts`).
 *
 * Canonical agent id: `eip155:{chainId}:{identityRegistryAddress}` per the
 * draft. `registrations[]` is caller-populated; an empty array is valid and
 * means "not yet anchored on-chain" — the document still carries the
 * off-chain identity + payment + trust facts.
 *
 * @module registry/erc8004-registration
 * @public
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Trust mechanisms an agent supports. The two standard EIP-8004 values plus
 * the Vauban-specific `run-certificate` (provable per-run execution).
 * @public
 */
export type Erc8004Trust = "reputation" | "tee-attestation" | "run-certificate";

/**
 * x402 payment support declaration per service (mirrors GOAT's `x402Support`).
 * @public
 */
export interface Erc8004X402Support {
  /** Settlement modes offered. */
  mode: Array<"DIRECT" | "DELEGATE">;
  /** Chains the service accepts payment on (e.g. `"starknet:sepolia"`). */
  chains: string[];
}

/**
 * A service an agent exposes. `type` mirrors the EIP-8004 service vocabulary.
 * @public
 */
export interface Erc8004Service {
  type: "a2a" | "mcp" | "x402" | "webhook" | "http";
  /** Service endpoint URL. */
  url: string;
  /** Human-readable description of the service. */
  description?: string;
  /** Present only when `type === "x402"` — declares payment support. */
  x402Support?: Erc8004X402Support;
}

/**
 * Builder input — everything except the defaults is explicit.
 * @public
 */
export interface Erc8004RegistrationInput {
  /** `"agent"` for an autonomous agent, `"service"` for a hosted capability. */
  type: "agent" | "service";
  /** Human-readable agent name (e.g. `"preste — Command Center"`). */
  name: string;
  /** One-paragraph description of what the agent does. */
  description: string;
  /** Services this agent exposes. */
  services: Erc8004Service[];
  /** Trust mechanisms this agent supports. MUST include `run-certificate`. */
  supportedTrust: Erc8004Trust[];
  /**
   * Payment wallet (EIP-8004 `get_agent_wallet`). MUST be the same address as
   * the payment-receipt-chain `recipient` for paid skills/APIs — this is what
   * makes a receipt verifiable against an identity.
   */
  agentWallet: string;
  /** Whether the agent is currently accepting work. Default: `true`. */
  active?: boolean;
  /**
   * Canonical EIP-8004 registration ids (`eip155:{chainId}:{registry}`) this
   * identity is anchored to. Empty = not yet anchored on-chain.
   */
  registrations?: string[];
  /** Free-form extensions (MUST NOT collide with reserved EIP-8004 fields). */
  metadata?: Record<string, unknown>;
}

/**
 * The produced document — `registration.json` shape.
 * @public
 */
export interface Erc8004Registration {
  type: "agent" | "service";
  name: string;
  description: string;
  services: Erc8004Service[];
  supportedTrust: Erc8004Trust[];
  agentWallet: string;
  active: boolean;
  registrations: string[];
  metadata?: Record<string, unknown>;
}

// ─── Canonical id ─────────────────────────────────────────────────────────────

/**
 * Build the canonical EIP-8004 agent id: `eip155:{chainId}:{identityRegistryAddress}`.
 *
 * @param chainId - EVM chain id per EIP-155 (GOAT mainnet is `2345`). For a
 *   future Starknet anchor, use the CAIP-2 chain namespace that the registry
 *   will adopt — the format is registry-defined; this helper covers the
 *   eip155 case that ERC-8004 specifies.
 * @public
 */
export function canonicalAgentId(chainId: string, identityRegistryAddress: string): string {
  if (!/^\d+$/.test(chainId)) {
    throw new Error(`[erc8004] chainId must be numeric (got "${chainId}")`);
  }
  if (!/^0x[a-fA-F0-9]+$/.test(identityRegistryAddress)) {
    throw new Error(
      `[erc8004] identityRegistryAddress must be a 0x hex address (got "${identityRegistryAddress}")`,
    );
  }
  return `eip155:${chainId}:${identityRegistryAddress}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural validation of an ERC-8004 registration document. Returns a list
 * of human-readable errors; an empty array means the document is valid.
 * Never throws — suitable for embedding in pipelines.
 * @public
 */
export function validateErc8004Registration(doc: unknown): string[] {
  const errors: string[] = [];
  if (typeof doc !== "object" || doc === null) {
    return ["document must be an object"];
  }
  const d = doc as Record<string, unknown>;

  if (d.type !== "agent" && d.type !== "service") {
    errors.push('type must be "agent" or "service"');
  }
  if (typeof d.name !== "string" || d.name.length === 0) {
    errors.push("name must be a non-empty string");
  }
  if (typeof d.description !== "string" || d.description.length === 0) {
    errors.push("description must be a non-empty string");
  }
  if (typeof d.agentWallet !== "string" || !/^0x[a-fA-F0-9]+$/.test(d.agentWallet)) {
    errors.push("agentWallet must be a 0x hex address");
  }
  if (!Array.isArray(d.services) || d.services.length === 0) {
    errors.push("services must be a non-empty array");
  } else {
    for (const svc of d.services) {
      if (typeof svc !== "object" || svc === null) {
        errors.push("services entries must be objects");
        continue;
      }
      const s = svc as Record<string, unknown>;
      const known = ["a2a", "mcp", "x402", "webhook", "http"];
      if (typeof s.type !== "string" || !known.includes(s.type)) {
        errors.push(`service type must be one of ${known.join(", ")}`);
      }
      if (typeof s.url !== "string" || s.url.length === 0) {
        errors.push("service url must be a non-empty string");
      }
    }
  }
  if (!Array.isArray(d.supportedTrust) || d.supportedTrust.length === 0) {
    errors.push("supportedTrust must be a non-empty array");
  } else {
    const known: Erc8004Trust[] = ["reputation", "tee-attestation", "run-certificate"];
    for (const t of d.supportedTrust) {
      if (!known.includes(t as Erc8004Trust)) {
        errors.push(`supportedTrust value "${String(t)}" is unknown`);
      }
    }
    // Fail-closed contract: a Vauban agent MUST carry the run-certificate
    // trust mechanism — that is what makes its runs independently provable.
    if (!d.supportedTrust.includes("run-certificate")) {
      errors.push('supportedTrust must include "run-certificate"');
    }
  }
  if (typeof d.active !== "boolean") {
    errors.push("active must be a boolean");
  }
  if (d.registrations !== undefined) {
    if (!Array.isArray(d.registrations)) {
      errors.push("registrations must be an array");
    } else {
      for (const r of d.registrations) {
        if (typeof r !== "string" || !r.startsWith("eip155:")) {
          errors.push(`registration id "${String(r)}" must be eip155:{chainId}:{registry}`);
        }
      }
    }
  }
  return errors;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a validated ERC-8004 `registration.json` document.
 *
 * Throws on invalid input (fail fast at authoring time); use
 * `validateErc8004Registration` for non-throwing checks.
 * @public
 */
export function buildErc8004Registration(input: Erc8004RegistrationInput): Erc8004Registration {
  // Defensive copies: the produced document must never alias the caller's
  // input arrays — mutating the doc (or the input) must not leak into the
  // other side.
  const doc: Erc8004Registration = {
    type: input.type,
    name: input.name,
    description: input.description,
    services: input.services.map((s) => ({ ...s })),
    supportedTrust: [...input.supportedTrust],
    agentWallet: input.agentWallet,
    active: input.active ?? true,
    registrations: [...(input.registrations ?? [])],
  };
  if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) {
    doc.metadata = input.metadata;
  }

  const errors = validateErc8004Registration(doc);
  if (errors.length > 0) {
    throw new Error(`[erc8004] invalid registration document:\n  - ${errors.join("\n  - ")}`);
  }
  return doc;
}

/**
 * Serialize a registration document to pretty-printed JSON (the `registration.json` file format).
 * @public
 */
export function toRegistrationJson(doc: Erc8004Registration): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
