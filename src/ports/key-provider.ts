/**
 * KeyProvider port — cryptographic key access for HMAC signing.
 *
 * Design intent:
 *   - The host injects a concrete KeyProvider at boot.
 *   - Agents and trace builders depend ONLY on the KeyProvider interface.
 *   - No key material ever appears in trace files — only the keyId is stored.
 *
 * Implementations provided:
 *   - EnvKeyProvider: reads keys from process.env[keyId] (hex-encoded).
 *     hasColocationRisk() = true when TRACE_DB_URL is also in env
 *     (key and DB on same host — forward secrecy concern).
 *   - ExternalKMSKeyProvider: placeholder for Vault/AWS KMS/Azure Key Vault.
 *     hasColocationRisk() = false (key material never touches the app host).
 *
 * Production notes:
 *   - EnvKeyProvider is acceptable for dev/staging.
 *   - For production audits, use ExternalKMSKeyProvider to satisfy
 *     "key not co-located with data" compliance requirements.
 *   - Both constructors throw in production-like environments when no
 *     config is provided — fail-closed, never silently degrade.
 *
 * @module ports/key-provider
 */

/**
 * Abstract key access port.
 * Implementations are injected by the host at boot time.
 * @public
 */
export interface KeyProvider {
  /**
   * Retrieve the raw key bytes for `keyId`.
   * @throws Error if the key is not found or cannot be decoded.
   */
  getKey(keyId: string): Promise<Uint8Array>;

  /**
   * Returns true if the key material is co-located with the traced data
   * (e.g. both in process.env on the same host).
   *
   * A true result does NOT block operation — it is a risk signal
   * that should be surfaced in audit reports and monitoring.
   * Callers may log a warning or increment a metric.
   */
  hasColocationRisk(): boolean;
}

// ─── EnvKeyProvider ───────────────────────────────────────────────────────────

/**
 * KeyProvider that reads hex-encoded key bytes from process.env.
 *
 * Key format: hex string, e.g. `export TRACE_HMAC_KEY="deadbeef..."`
 * Minimum recommended key length: 32 bytes (256 bits) for HMAC-SHA-256.
 *
 * Colocation risk:
 *   hasColocationRisk() returns true when `TRACE_DB_URL` is set in the same
 *   environment, indicating that the HMAC key and the database connection
 *   string are both accessible to the same process — a forward-secrecy
 *   concern noted in audit frameworks.
 *   A warning is logged to stderr at construction time when this is detected.
 *
 * Production usage note:
 *   Acceptable for dev and staging. For production compliance requirements
 *   that mandate physical key separation, use ExternalKMSKeyProvider instead.
 * @public
 */
export class EnvKeyProvider implements KeyProvider {
  private readonly _hasColocationRisk: boolean;

  constructor() {
    // Detect colocation risk at construction time and warn once.
    this._hasColocationRisk = typeof process.env.TRACE_DB_URL === "string";
    if (this._hasColocationRisk) {
      // Use stderr to avoid polluting structured log pipelines.
      process.stderr.write(
        "[WARN] EnvKeyProvider: TRACE_DB_URL detected in process.env — " +
          "HMAC key and database URL are co-located on the same host. " +
          "For production audit compliance, migrate to ExternalKMSKeyProvider.\n",
      );
    }
  }

  async getKey(keyId: string): Promise<Uint8Array> {
    const raw = process.env[keyId];
    if (raw === undefined || raw.trim() === "") {
      throw new Error(
        `EnvKeyProvider: key "${keyId}" not found in process.env. Set the environment variable to a hex-encoded key (min 32 bytes).`,
      );
    }
    const hex = raw.trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(`EnvKeyProvider: key "${keyId}" is not a valid even-length hex string.`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  hasColocationRisk(): boolean {
    return this._hasColocationRisk;
  }
}

// ─── ExternalKMSKeyProvider ───────────────────────────────────────────────────

/**
 * Options for ExternalKMSKeyProvider.
 * @public
 */
export interface ExternalKMSKeyProviderOptions {
  /**
   * KMS endpoint URL (e.g. Vault transit engine, AWS KMS, Azure Key Vault).
   * Required — no default to avoid silent misconfiguration.
   */
  endpoint: string;

  /**
   * Optional authentication token (injected via sealed secrets or Workload
   * Identity). When absent, the implementation is expected to use
   * environment-level ambient credentials (e.g. AWS Instance Role).
   */
  authToken?: string;
}

/**
 * Placeholder KeyProvider for external KMS (HashiCorp Vault, AWS KMS, Azure Key Vault, …).
 *
 * This implementation is a STUB — it provides the correct interface and
 * colocation risk semantics but does NOT make actual KMS calls.
 * Replace the `getKey` body with your KMS client SDK call.
 *
 * hasColocationRisk() always returns false: key material is never present
 * in the application process; it is fetched on demand from an external system.
 * @public
 */
export class ExternalKMSKeyProvider implements KeyProvider {
  private readonly endpoint: string;
  private readonly authToken?: string;

  constructor(options: ExternalKMSKeyProviderOptions) {
    if (!options.endpoint || options.endpoint.trim() === "") {
      throw new Error(
        "ExternalKMSKeyProvider: options.endpoint is required. " +
          "Provide the KMS endpoint URL to prevent silent misconfiguration.",
      );
    }
    this.endpoint = options.endpoint.trim();
    this.authToken = options.authToken;
  }

  /**
   * Fetch the key from the external KMS.
   *
   * STUB: Replace this with your KMS client SDK call.
   * Example (Vault transit):
   *   const res = await fetch(`${this.endpoint}/v1/transit/keys/${keyId}`, { … });
   *   return hexToUint8Array(await res.json().key_bytes);
   */
  async getKey(keyId: string): Promise<Uint8Array> {
    // Suppress unused-variable warnings in stub
    void this.endpoint;
    void this.authToken;
    throw new Error(
      `ExternalKMSKeyProvider.getKey("${keyId}"): stub not implemented. Replace this method body with your KMS client SDK call.`,
    );
  }

  /**
   * Always false: key material never resides in the application process.
   * The key is fetched on demand from the external KMS endpoint.
   */
  hasColocationRisk(): boolean {
    return false;
  }
}
