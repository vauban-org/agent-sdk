/**
 * FederationPort — agent-to-agent messaging with cryptographic provenance (S4 spec).
 *
 * Implements A2A v1.0 transport (JWS RFC 7515) superset with Vauban Claim sextuplet
 * payload. Messages routed by consistent hashing on tenant_id. Delegation chains preserved.
 * Ed25519 signatures over CBOR canonical encoding.
 *
 * Spec: docs/plans/PreCarre/canonical/specs/S4.md
 */

// ─── Message types (S4 §3) ────────────────────────────────────────────────────

export type Protocol = "mcp" | "a2a-jsonrpc" | "a2a-grpc" | "http-gateway";

/** @public */
export interface AgentRef {
  readonly agent_id: string; // e.g. "vauban.cc.synthesizer@v2.1"
  readonly tenant_id: string; // crosslink S2
  readonly agent_card_url?: string; // A2A discovery URL
}

/** @public */
export interface FederationMessageHeader {
  readonly message_id: string; // UUIDv7, timestamp-ordered
  readonly from_agent: AgentRef;
  readonly to_agent: AgentRef;
  readonly correlation_id: string; // conversation tracking
  readonly causation_id?: string; // parent message in chain
  readonly timestamp: string; // ISO 8601
  readonly nonce: string; // 32-byte hex, replay protection
}

/** @public */
export interface TransportMeta {
  readonly protocol: Protocol;
  readonly version: string; // SemVer
  readonly jws_signature: string; // RFC 7515 JWS (outer, transport-level)
}

/**
 * Content claim payload — Vauban Claim sextuplet.
 * Domain normalized to "vauban.federation.message.v1" for all S4 messages.
 * @public
 */
export interface ContentClaim {
  readonly subject: string; // ArtefactDigest(message_id)
  readonly predicate: {
    readonly domain: "vauban.federation.message.v1";
    readonly body: Record<string, unknown>; // action + payload
  };
  readonly evidence: {
    readonly proof: string; // Ed25519 hex signature
    readonly public_inputs: Record<string, unknown>;
  };
  readonly temporal_frame: {
    readonly not_before: string; // ISO 8601
    readonly not_after: string; // ISO 8601
    readonly revoked_at?: string | null;
  };
  readonly revelation_mask: {
    readonly disclosed: string[]; // JSON pointers
    readonly committed: string[];
  };
  readonly anchor: ReadonlyArray<{
    readonly chain: "StarknetMainnet" | "StarknetL3Glacis";
    readonly tx_hash?: string;
  }>;
}

/** @public */
export interface FederationMessage {
  readonly id: string;
  readonly header: FederationMessageHeader;
  readonly content_claim: ContentClaim;
  readonly transport: TransportMeta;
  readonly delegation_chain?: ReadonlyArray<{
    readonly id: string;
    readonly parent_id?: string;
    readonly scope: {
      readonly capabilities: ReadonlyArray<string>;
      readonly constraints: ReadonlyArray<unknown>;
      readonly jurisdictions: ReadonlyArray<string>;
      readonly expires_at: string;
    };
    readonly ed25519_sig: string;
  }>; // optional narrow chain
}

/** @public */
export type MessageId = string;

// ─── Verification result ──────────────────────────────────────────────────────

/** @public */
export interface VerifyResult {
  readonly valid: boolean;
  readonly errors: string[]; // empty if valid
  readonly signer_agent_id?: string; // extracted from signature
  readonly chain_depth?: number; // delegation chain length if present
}

// ─── Receive options ─────────────────────────────────────────────────────────

/** @public */
export interface ReceiveOpts {
  readonly destinationTenantId?: string; // filter by dest
  readonly timeout?: number; // ms, default 5000
  readonly maxMessages?: number; // batch size, default 10
}

// ─── FederationPort interface ────────────────────────────────────────────────

/** @public */
export interface FederationPort {
  /**
   * Send a message to another agent.
   * Message is JWS-signed and routed by consistent hashing on destination tenant_id.
   * Returns message_id on success.
   */
  send(message: FederationMessage, opts?: { timeoutMs?: number }): Promise<MessageId>;

  /**
   * Receive pending messages (subscriber pattern).
   * Messages are routed to this agent's tenant by consistent hash.
   * Returns empty array if no messages within timeout window.
   */
  receive(opts?: ReceiveOpts): Promise<FederationMessage[]>;

  /**
   * Verify JWS signature and Claim sextuplet integrity.
   * Checks Ed25519 signature, CBOR canonicalization, temporal bounds, delegation chain narrowing.
   * Does NOT verify on-chain anchor (separate concern).
   */
  verifyMessage(msg: FederationMessage): Promise<VerifyResult>;

  /**
   * Acknowledge a received message to mark it as consumed.
   * Prevents redelivery.
   */
  ack(messageId: MessageId): Promise<void>;

  /**
   * Nack a message to return it to the queue (poison pill protection).
   * Max 3 nacks per message, then dead-letter.
   */
  nack(messageId: MessageId, reason?: string): Promise<void>;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** @public */
export class FederationSignatureInvalidError extends Error {
  constructor(
    public readonly messageId: string,
    public readonly reason: string,
  ) {
    super(`Federation signature invalid (${messageId}): ${reason}`);
    this.name = "FederationSignatureInvalidError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class FederationRoutingError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly reason: string,
  ) {
    super(`Federation routing failed for tenant ${tenantId}: ${reason}`);
    this.name = "FederationRoutingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @public */
export class FederationDelegationChainError extends Error {
  constructor(
    public readonly messageId: string,
    public readonly chainDepth: number,
    public readonly reason: string,
  ) {
    super(`Federation delegation chain invalid (${messageId}, depth=${chainDepth}): ${reason}`);
    this.name = "FederationDelegationChainError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FederationMessageExpiredError extends Error {
  constructor(
    public readonly messageId: string,
    public readonly notAfter: string,
  ) {
    super(`Federation message expired (${messageId}): not_after=${notAfter}`);
    this.name = "FederationMessageExpiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
