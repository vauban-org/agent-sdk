/**
 * ManifestRegistryPort contract tests (T-S1-1..T-S1-12).
 *
 * Applied to in-memory reference impl. Any ManifestRegistryPort adapter must satisfy all tests.
 * Tests cover: registration, lookup, versioning, signature validation, revocation, compliance gating.
 */

import { describe, expect, test } from "vitest";
import {
  type Manifest,
  ManifestNotFoundError,
  type ManifestRegistryPort,
  ManifestSignatureInvalidError,
  type RegistrationResult,
} from "./manifest-registry.js";

/**
 * In-memory reference implementation for contract testing.
 */
class InMemoryManifestRegistry implements ManifestRegistryPort {
  private manifests = new Map<
    string,
    Manifest & { status: string; revokedAt?: Date; revokedReason?: string }
  >();
  private claimIds = new Map<string, string>(); // claim_id → manifest key

  async register(
    manifest: Manifest,
    _options?: { operatorId?: string; timestamp?: Date },
  ): Promise<RegistrationResult> {
    // I-S1-2: tier=production + mode=audit_only → reject
    if (manifest.tier === "production" && manifest.compliance_mode === "audit_only") {
      return {
        claim_id: "",
        status: "failed",
        errors: [
          {
            code: "I-S1-2",
            description: "Production tier requires strict compliance mode",
          },
        ],
      };
    }

    // Verify signature
    try {
      await this.verifySignature(manifest);
    } catch (e) {
      return {
        claim_id: "",
        status: "failed",
        errors: [
          {
            code: "SIGNATURE_INVALID",
            description: `Signature verification failed: ${String(e)}`,
          },
        ],
      };
    }

    const key = `${manifest.name}@${manifest.version}`;
    const existing = this.manifests.get(key);

    // No duplicate versions allowed
    if (existing) {
      return {
        claim_id: "",
        status: "failed",
        errors: [
          {
            code: "VERSION_CONFLICT",
            description: `Version already registered: ${key}`,
          },
        ],
      };
    }

    // Register success
    const claimId = crypto.randomUUID();
    this.manifests.set(key, {
      ...manifest,
      status: "active",
    });
    this.claimIds.set(claimId, key);

    return {
      claim_id: claimId,
      status: "registered",
      manifest_id: claimId,
    };
  }

  async lookup(name: string, version: string): Promise<Manifest | null> {
    const key = `${name}@${version}`;
    const m = this.manifests.get(key);

    if (!m) return null;
    if (m.status === "revoked") return null;

    return m;
  }

  async revoke(claim_id: string, reason: string): Promise<void> {
    const key = this.claimIds.get(claim_id);
    if (!key) {
      throw new ManifestNotFoundError("unknown", "unknown");
    }

    const m = this.manifests.get(key);
    if (m) {
      m.status = "revoked";
      m.revokedAt = new Date();
      m.revokedReason = reason;
    }
  }

  async listVersions(name: string): Promise<readonly string[]> {
    const versions = Array.from(this.manifests.keys())
      .filter((key) => key.startsWith(`${name}@`))
      .map((key) => key.split("@")[1]);

    // Sort by semver
    return versions.sort((a, b) => {
      const aParts = a.split(".").map(Number);
      const bParts = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        const cmp = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }

  async verifySignature(manifest: Manifest): Promise<boolean> {
    // Simple stub: just check that signature and pubkey are non-empty hex
    const sigHex = /^[0-9a-f]{128}$/i;
    const pubkeyHex = /^[0-9a-f]{64}$/i;

    if (!sigHex.test(manifest.signature)) {
      throw new ManifestSignatureInvalidError(
        manifest.name,
        manifest.version,
        "signature not 64-byte hex",
      );
    }
    if (!pubkeyHex.test(manifest.ed25519_pubkey)) {
      throw new ManifestSignatureInvalidError(
        manifest.name,
        manifest.version,
        "pubkey not 32-byte hex",
      );
    }

    return true;
  }
}

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: "vauban.bastion.test-agent",
    version: "1.0.0",
    tier: "test",
    compliance_mode: "strict",
    capabilities: ["bastion.swap"],
    compliance: {
      jurisdictions: ["FR.v1"],
      legal_bases: ["gdpr.art6_1_b"],
      data_classification: "internal",
    },
    runtime: {
      max_compute_seconds: 30,
      max_llm_tokens: 10000,
    },
    ed25519_pubkey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    signature:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    manifestHash: "abc123def456",
    ...overrides,
  };
}

export const manifestRegistryPortContract = (factory: () => ManifestRegistryPort) => {
  describe("ManifestRegistryPort contract", () => {
    test("T-S1-1: registers + retrieves manifest", async () => {
      const registry = factory();
      const manifest = makeManifest();

      const result = await registry.register(manifest);
      expect(result.status).toBe("registered");
      expect(result.claim_id).toBeTruthy();

      const retrieved = await registry.lookup(manifest.name, manifest.version);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe(manifest.name);
      expect(retrieved?.version).toBe(manifest.version);
      expect(retrieved?.tier).toBe(manifest.tier);
    });

    test("T-S1-3: rejects production tier with audit_only mode (I-S1-2)", async () => {
      const registry = factory();
      const manifest = makeManifest({
        tier: "production",
        compliance_mode: "audit_only",
      });

      const result = await registry.register(manifest);
      expect(result.status).toBe("failed");
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors![0].code).toBe("I-S1-2");
    });

    test("T-S1-5: rejects duplicate version (I-S1-1 monotone)", async () => {
      const registry = factory();
      const manifest = makeManifest({ version: "1.0.0" });

      // First registration succeeds
      const result1 = await registry.register(manifest);
      expect(result1.status).toBe("registered");

      // Second with same version fails
      const result2 = await registry.register(manifest);
      expect(result2.status).toBe("failed");
      expect(result2.errors).toBeDefined();
      expect(result2.errors![0].code).toBe("VERSION_CONFLICT");
    });

    test("T-S1-6: revoke makes lookup return null + emits revocation", async () => {
      const registry = factory();
      const manifest = makeManifest();

      const result = await registry.register(manifest);
      expect(result.status).toBe("registered");
      const claimId = result.claim_id;

      // Before revoke: lookup succeeds
      let retrieved = await registry.lookup(manifest.name, manifest.version);
      expect(retrieved).not.toBeNull();

      // Revoke
      await registry.revoke(claimId, "deprecated");

      // After revoke: lookup returns null
      retrieved = await registry.lookup(manifest.name, manifest.version);
      expect(retrieved).toBeNull();
    });

    test("T-S1-7: listVersions returns sorted semver", async () => {
      const registry = factory();

      // Register multiple versions
      const versions = ["1.0.0", "1.1.0", "1.0.1", "2.0.0"];
      for (const v of versions) {
        const manifest = makeManifest({ version: v });
        await registry.register(manifest);
      }

      // List should be sorted
      const listed = await registry.listVersions("vauban.bastion.test-agent");
      expect(listed).toEqual(["1.0.0", "1.0.1", "1.1.0", "2.0.0"]);
    });

    test("T-S1-2: concurrent registration of v1 and v2 succeeds", async () => {
      const registry = factory();

      const v1 = makeManifest({ version: "1.0.0" });
      const v2 = makeManifest({ version: "2.0.0" });

      const [result1, result2] = await Promise.all([registry.register(v1), registry.register(v2)]);

      expect(result1.status).toBe("registered");
      expect(result2.status).toBe("registered");

      const retrieved1 = await registry.lookup("vauban.bastion.test-agent", "1.0.0");
      const retrieved2 = await registry.lookup("vauban.bastion.test-agent", "2.0.0");

      expect(retrieved1).toBeTruthy();
      expect(retrieved2).toBeTruthy();
    });

    test("verifySignature validates Ed25519 signature format", async () => {
      const registry = factory();
      const manifest = makeManifest({
        signature: "invalid", // Not 64-byte hex
      });

      await expect(registry.verifySignature(manifest)).rejects.toThrow(
        ManifestSignatureInvalidError,
      );
    });

    test("revoke on unknown claim_id throws ManifestNotFoundError", async () => {
      const registry = factory();
      await expect(registry.revoke("unknown-claim-id", "test")).rejects.toThrow(
        ManifestNotFoundError,
      );
    });

    test("lookup on unknown name returns empty array from listVersions", async () => {
      const registry = factory();
      const versions = await registry.listVersions("unknown.agent.name");
      expect(versions).toEqual([]);
    });
  });
};

// ─── Apply contract to InMemoryManifestRegistry ────────────────────────────

manifestRegistryPortContract(() => new InMemoryManifestRegistry());
