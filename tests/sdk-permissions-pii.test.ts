/**
 * Tests for sdk-permissions.ts + strict-pii-detector.ts
 *
 * Coverage (sdk-permissions):
 *   mapScopesToSdkPermissions — cc:admin, cc:execute, cc:read, no cc:* scope
 *   permitsCapability — bash/fileIO/web/mcp per scope
 *   permitsMcpScopes — empty required, all present, missing scope
 *
 * Coverage (STRICT_PII_DETECTOR):
 *   email addresses (valid, invalid domains, adjacent text)
 *   IBANs (valid FR, valid DE, invalid checksum, invalid country)
 *   non-string values → false
 *
 * Ref: test coverage for sdk-permissions.ts + strict-pii-detector.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  mapScopesToSdkPermissions,
  permitsCapability,
  permitsMcpScopes,
} from "../src/permissions/sdk-permissions.js";
import { STRICT_PII_DETECTOR } from "../src/trace/strict-pii-detector.js";

// ─── mapScopesToSdkPermissions ────────────────────────────────────────────────

describe("mapScopesToSdkPermissions", () => {
  it("cc:admin grants full surface", () => {
    const p = mapScopesToSdkPermissions(["cc:admin"]);
    expect(p.bash).toBe("restricted");
    expect(p.fileIO).toBe("sandboxed");
    expect(p.web).toBe(true);
    expect(p.mcp.length).toBeGreaterThan(0);
  });

  it("cc:execute grants restricted bash and sandboxed fileIO, no web", () => {
    const p = mapScopesToSdkPermissions(["cc:execute"]);
    expect(p.bash).toBe("restricted");
    expect(p.fileIO).toBe("sandboxed");
    expect(p.web).toBe(false);
  });

  it("cc:read grants read-only fileIO, no bash, no web", () => {
    const p = mapScopesToSdkPermissions(["cc:read"]);
    expect(p.bash).toBe(false);
    expect(p.fileIO).toBe("ro");
    expect(p.web).toBe(false);
  });

  it("no cc:* scope → empty permissions (fail-closed)", () => {
    const p = mapScopesToSdkPermissions(["some:other:scope"]);
    expect(p.bash).toBe(false);
    expect(p.fileIO).toBe("none");
    expect(p.web).toBe(false);
    expect(p.mcp).toHaveLength(0);
  });

  it("admin takes priority over execute/read in list", () => {
    const p = mapScopesToSdkPermissions(["cc:read", "cc:execute", "cc:admin"]);
    expect(p.web).toBe(true);
  });
});

// ─── permitsCapability ────────────────────────────────────────────────────────

describe("permitsCapability", () => {
  it("bash: true when bash !== false", () => {
    const p = mapScopesToSdkPermissions(["cc:execute"]);
    expect(permitsCapability(p, "bash")).toBe(true);
  });

  it("bash: false when bash === false", () => {
    const p = mapScopesToSdkPermissions(["cc:read"]);
    expect(permitsCapability(p, "bash")).toBe(false);
  });

  it("fileIO: true when fileIO !== none", () => {
    const p = mapScopesToSdkPermissions(["cc:read"]);
    expect(permitsCapability(p, "fileIO")).toBe(true);
  });

  it("fileIO: false when fileIO === none", () => {
    const p = mapScopesToSdkPermissions([]);
    expect(permitsCapability(p, "fileIO")).toBe(false);
  });

  it("web: mirrors permissions.web", () => {
    expect(permitsCapability(mapScopesToSdkPermissions(["cc:admin"]), "web")).toBe(true);
    expect(permitsCapability(mapScopesToSdkPermissions(["cc:read"]), "web")).toBe(false);
  });

  it("mcp: true when mcp list is non-empty", () => {
    const p = mapScopesToSdkPermissions(["cc:read"]);
    expect(permitsCapability(p, "mcp")).toBe(true);
  });

  it("mcp: false when mcp list is empty", () => {
    const p = mapScopesToSdkPermissions([]);
    expect(permitsCapability(p, "mcp")).toBe(false);
  });
});

// ─── permitsMcpScopes ─────────────────────────────────────────────────────────

describe("permitsMcpScopes", () => {
  const adminPerms = mapScopesToSdkPermissions(["cc:admin"]);
  const readPerms = mapScopesToSdkPermissions(["cc:read"]);

  it("returns true when required is empty", () => {
    expect(permitsMcpScopes(readPerms, [])).toBe(true);
  });

  it("returns true when all required scopes are present", () => {
    expect(permitsMcpScopes(adminPerms, ["brain:read", "brain:write"])).toBe(true);
  });

  it("returns false when a required scope is missing", () => {
    expect(permitsMcpScopes(readPerms, ["brain:write"])).toBe(false);
  });
});

// ─── STRICT_PII_DETECTOR ──────────────────────────────────────────────────────

describe("STRICT_PII_DETECTOR", () => {
  it("detects a valid email address", () => {
    expect(STRICT_PII_DETECTOR("alice@example.com")).toBe(true);
  });

  it("detects email with subdomain", () => {
    expect(STRICT_PII_DETECTOR("user@mail.example.co.uk")).toBe(true);
  });

  it("rejects non-email string", () => {
    expect(STRICT_PII_DETECTOR("not-an-email")).toBe(false);
    expect(STRICT_PII_DETECTOR("run-id-abc123")).toBe(false);
  });

  it("rejects email-like with numeric TLD", () => {
    expect(STRICT_PII_DETECTOR("user@example.123")).toBe(false);
  });

  it("detects valid French IBAN", () => {
    // FR76 3000 6000 0112 3456 7890 189 (official example)
    expect(STRICT_PII_DETECTOR("FR7630006000011234567890189")).toBe(true);
  });

  it("detects valid German IBAN", () => {
    expect(STRICT_PII_DETECTOR("DE89370400440532013000")).toBe(true);
  });

  it("rejects IBAN with invalid checksum", () => {
    expect(STRICT_PII_DETECTOR("DE00370400440532013000")).toBe(false);
  });

  it("rejects IBAN-shaped string with unknown country code", () => {
    expect(STRICT_PII_DETECTOR("ZZ9912345678901234")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(STRICT_PII_DETECTOR(42)).toBe(false);
    expect(STRICT_PII_DETECTOR(null)).toBe(false);
    expect(STRICT_PII_DETECTOR({ email: "user@example.com" })).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(STRICT_PII_DETECTOR("")).toBe(false);
    expect(STRICT_PII_DETECTOR("   ")).toBe(false);
  });
});
