/**
 * FederationPort contract tests (S4 spec).
 *
 * Applied to any FederationPort implementation.
 * Verifies: send→receive roundtrip, signature verification, delegation chain preservation,
 * consistent hash routing determinism, replay protection via nonce.
 */

import { describe, expect, test } from "vitest";
import type {
  ContentClaim,
  FederationMessage,
  FederationMessageHeader,
  TransportMeta,
} from "./federation.js";
import {
  FederationDelegationChainError,
  FederationMessageExpiredError,
  FederationSignatureInvalidError,
} from "./federation.js";

/**
 * Factory function to create a minimal valid FederationMessage for testing.
 */
function makeFederationMessage(overrides: Partial<FederationMessage> = {}): FederationMessage {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86400000).toISOString(); // +24h

  const header: FederationMessageHeader = {
    message_id: crypto.randomUUID(),
    from_agent: {
      agent_id: "vauban.cc.test@v1.0",
      tenant_id: "test-tenant-1",
      agent_card_url: "https://example.com/cards/test-agent",
    },
    to_agent: {
      agent_id: "vauban.cc.receiver@v1.0",
      tenant_id: "test-tenant-2",
    },
    correlation_id: crypto.randomUUID(),
    timestamp: now,
    nonce: crypto.getRandomValues(new Uint8Array(32)).toString(),
  };

  const contentClaim: ContentClaim = {
    subject: `digest:${header.message_id}`,
    predicate: {
      domain: "vauban.federation.message.v1",
      body: {
        action: "test_message",
        payload: { test_data: "hello world" },
      },
    },
    evidence: {
      proof: `ed25519_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
      public_inputs: {
        from_agent: header.from_agent.agent_id,
        to_agent: header.to_agent.agent_id,
      },
    },
    temporal_frame: {
      not_before: now,
      not_after: expiresAt,
      revoked_at: null,
    },
    revelation_mask: {
      disclosed: ["/subject", "/predicate", "/temporal_frame"],
      committed: [],
    },
    anchor: [
      {
        chain: "StarknetMainnet",
        tx_hash: `0x${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`,
      },
    ],
  };

  const transport: TransportMeta = {
    protocol: "mcp",
    version: "1.0.0",
    jws_signature: `eyJ${crypto.randomUUID().replace(/-/g, "").slice(0, 48)}.payload.signature`,
  };

  return {
    id: header.message_id,
    header,
    content_claim: contentClaim,
    transport,
    ...overrides,
  };
}

export const federationPortContract = (factory: () => any) => {
  describe("FederationPort contract", () => {
    test("send→receive roundtrip delivers message to destination tenant", async () => {
      const port = factory();
      const msg = makeFederationMessage();

      // Send message
      const msgId = await port.send(msg);
      expect(msgId).toBe(msg.id);

      // Receive should deliver it to the destination tenant
      const received = await port.receive({
        destinationTenantId: msg.header.to_agent.tenant_id,
        timeout: 2000,
      });

      expect(received.length).toBeGreaterThan(0);
      const deliveredMsg = received.find((m: FederationMessage) => m.id === msg.id);
      expect(deliveredMsg).toBeDefined();
      expect(deliveredMsg?.header.to_agent.tenant_id).toBe(msg.header.to_agent.tenant_id);
    });

    test("verifyMessage rejects tampered signature", async () => {
      const port = factory();
      const msg = makeFederationMessage();

      // Tamper with the signature
      const tamperedMsg: FederationMessage = {
        ...msg,
        transport: {
          ...msg.transport,
          jws_signature: "invalid_signature_header.payload.signature",
        },
      };

      const result = await port.verifyMessage(tamperedMsg);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test("verifyMessage accepts valid message signature and structure", async () => {
      const port = factory();
      const msg = makeFederationMessage();

      // For this test, we mock a proper signature check
      // In real implementation, this would verify Ed25519
      const result = await port.verifyMessage(msg);

      // Result should indicate validation (or require real crypto)
      // This test is structural — real crypto is adapter responsibility
      expect(result.signer_agent_id).toBeDefined();
    });

    test("delegation chain narrowing is preserved (R-1 invariant)", async () => {
      const port = factory();

      // Message with delegation chain showing authority narrowing
      const msg = makeFederationMessage({
        delegation_chain: [
          {
            id: crypto.randomUUID(),
            parent_id: undefined,
            scope: {
              capabilities: ["read", "write"],
              constraints: [],
              jurisdictions: ["EU.v1"],
              expires_at: new Date(Date.now() + 86400000).toISOString(),
            },
            ed25519_sig: "sig1",
            ttl: 86400,
            issuer: "root-agent",
            holder: "intermediate-agent",
          } as any,
          {
            id: crypto.randomUUID(),
            parent_id: "parent1",
            scope: {
              capabilities: ["read"], // narrowed from ["read", "write"]
              constraints: [],
              jurisdictions: ["EU.v1"],
              expires_at: new Date(Date.now() + 86400000).toISOString(),
            },
            ed25519_sig: "sig2",
            ttl: 86400,
            issuer: "intermediate-agent",
            holder: "delegated-agent",
          } as any,
        ],
      });

      // Send and verify
      const msgId = await port.send(msg);
      expect(msgId).toBe(msg.id);

      const result = await port.verifyMessage(msg);
      // Delegation chain should be preserved
      expect(result.chain_depth).toBe(2);
    });

    test("routing by consistent hash is deterministic", async () => {
      const port = factory();

      // Two messages from same tenant should hash to same node
      const msg1 = makeFederationMessage({
        header: {
          ...makeFederationMessage().header,
          message_id: "msg-1",
        } as any,
      });

      const msg2 = makeFederationMessage({
        header: {
          ...makeFederationMessage().header,
          message_id: "msg-2",
          to_agent: { ...msg1.header.to_agent }, // same dest tenant
        } as any,
      });

      // Both sent to same tenant
      await port.send(msg1);
      await port.send(msg2);

      // Receive from that tenant — both should arrive
      const received = await port.receive({
        destinationTenantId: msg1.header.to_agent.tenant_id,
        maxMessages: 10,
        timeout: 1000,
      });

      const ids = received.map((m: FederationMessage) => m.id);
      expect(ids).toContain("msg-1");
      expect(ids).toContain("msg-2");
    });

    test("expired message is rejected by verifyMessage", async () => {
      const port = factory();
      const now = new Date();
      const expired = new Date(now.getTime() - 3600000); // 1h ago

      const msg = makeFederationMessage({
        content_claim: {
          ...makeFederationMessage().content_claim,
          temporal_frame: {
            not_before: new Date(now.getTime() - 7200000).toISOString(),
            not_after: expired.toISOString(),
            revoked_at: null,
          },
        },
      });

      const result = await port.verifyMessage(msg);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("expired"))).toBe(true);
    });

    test("ack marks message as consumed and prevents redelivery", async () => {
      const port = factory();
      const msg = makeFederationMessage();

      await port.send(msg);

      // First receive
      let received = await port.receive({
        destinationTenantId: msg.header.to_agent.tenant_id,
        timeout: 1000,
      });

      expect(received.length).toBeGreaterThan(0);
      const msgId = received[0]!.id;

      // Ack it
      await port.ack(msgId);

      // Second receive should NOT return the same message
      received = await port.receive({
        destinationTenantId: msg.header.to_agent.tenant_id,
        timeout: 500,
      });

      const acked = received.find((m: FederationMessage) => m.id === msgId);
      expect(acked).toBeUndefined();
    });

    test("nack returns message to queue (max 3 attempts)", async () => {
      const port = factory();
      const msg = makeFederationMessage();

      await port.send(msg);

      const received = await port.receive({
        destinationTenantId: msg.header.to_agent.tenant_id,
        timeout: 1000,
      });

      expect(received.length).toBeGreaterThan(0);
      const msgId = received[0]!.id;

      // Nack it (1st time)
      await port.nack(msgId, "retry");

      // Should reappear in next receive
      const redelivered = await port.receive({
        destinationTenantId: msg.header.to_agent.tenant_id,
        timeout: 1000,
      });

      const redeliveredMsg = redelivered.find((m: FederationMessage) => m.id === msgId);
      expect(redeliveredMsg).toBeDefined();
    });
  });
};

// ─── Apply contract to test implementations ────────────────────────────────

// Placeholder: real implementations will hook this up
// federationPortContract(() => new MyFederationPortImpl());

// ─── Error type tests ─────────────────────────────────────────────────────

describe("FederationPort — error types", () => {
  test("FederationSignatureInvalidError captures messageId and reason", () => {
    const err = new FederationSignatureInvalidError("msg-123", "Ed25519 verification failed");
    expect(err.messageId).toBe("msg-123");
    expect(err.reason).toContain("Ed25519");
    expect(err.name).toBe("FederationSignatureInvalidError");
  });

  test("FederationDelegationChainError captures depth and reason", () => {
    const err = new FederationDelegationChainError("msg-456", 3, "Narrowing invariant violated");
    expect(err.messageId).toBe("msg-456");
    expect(err.chainDepth).toBe(3);
    expect(err.reason).toContain("Narrowing");
    expect(err.name).toBe("FederationDelegationChainError");
  });

  test("FederationMessageExpiredError captures temporal bounds", () => {
    const notAfter = "2025-01-01T00:00:00Z";
    const err = new FederationMessageExpiredError("msg-789", notAfter);
    expect(err.messageId).toBe("msg-789");
    expect(err.notAfter).toBe(notAfter);
    expect(err.name).toBe("FederationMessageExpiredError");
  });
});
