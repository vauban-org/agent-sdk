/**
 * Unit tests for ManifestRegistryPort typed error classes and constants.
 *
 * Tests: ManifestNotFoundError, ManifestSignatureInvalidError,
 * ManifestVersionConflictError, ManifestComplianceConflictError,
 * ManifestValidationError, SUPPORTED_TIERS constant.
 */

import { describe, expect, test } from "vitest";
import {
  type ComplianceError,
  ManifestComplianceConflictError,
  ManifestNotFoundError,
  ManifestSignatureInvalidError,
  ManifestValidationError,
  ManifestVersionConflictError,
  SUPPORTED_TIERS,
} from "../src/ports/manifest-registry.js";

// ─── ManifestNotFoundError ────────────────────────────────────────────────────

describe("ManifestNotFoundError", () => {
  test("is an instance of Error", () => {
    const err = new ManifestNotFoundError("vauban.agent.x", "1.0.0");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ManifestNotFoundError", () => {
    const err = new ManifestNotFoundError("vauban.agent.x", "1.0.0");
    expect(err.name).toBe("ManifestNotFoundError");
  });

  test("name field is stored correctly", () => {
    const err = new ManifestNotFoundError("vauban.bastion.vault", "2.1.0");
    expect(err.name).toBe("ManifestNotFoundError");
  });

  test("version field is stored correctly", () => {
    const err = new ManifestNotFoundError("vauban.agent.x", "3.0.0");
    expect(err.version).toBe("3.0.0");
  });

  test("message contains name and version in name@version format", () => {
    const err = new ManifestNotFoundError("vauban.cc.synthesizer", "1.2.3");
    expect(err.message).toContain("vauban.cc.synthesizer@1.2.3");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new ManifestNotFoundError("a", "0.0.1");
    expect(err instanceof ManifestNotFoundError).toBe(true);
  });

  test("stack trace is defined", () => {
    const err = new ManifestNotFoundError("a", "0.0.1");
    expect(err.stack).toBeDefined();
  });
});

// ─── ManifestSignatureInvalidError ────────────────────────────────────────────

describe("ManifestSignatureInvalidError", () => {
  test("is an instance of Error", () => {
    const err = new ManifestSignatureInvalidError("agent.x", "1.0.0");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ManifestSignatureInvalidError", () => {
    const err = new ManifestSignatureInvalidError("agent.x", "1.0.0");
    expect(err.name).toBe("ManifestSignatureInvalidError");
  });

  test("name field is stored correctly", () => {
    const err = new ManifestSignatureInvalidError("vauban.forge.x", "0.5.0");
    expect(err.name).toBe("ManifestSignatureInvalidError");
  });

  test("version field is stored correctly", () => {
    const err = new ManifestSignatureInvalidError("agent.y", "2.0.0");
    expect(err.version).toBe("2.0.0");
  });

  test("message contains name and version", () => {
    const err = new ManifestSignatureInvalidError("vauban.brain.query", "1.1.0");
    expect(err.message).toContain("vauban.brain.query@1.1.0");
  });

  test("cause field is stored when provided", () => {
    const cause = new Error("underlying crypto failure");
    const err = new ManifestSignatureInvalidError("a", "0.1.0", cause);
    expect(err.cause).toBe(cause);
  });

  test("cause field is undefined when not provided", () => {
    const err = new ManifestSignatureInvalidError("a", "0.1.0");
    expect(err.cause).toBeUndefined();
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new ManifestSignatureInvalidError("a", "0.1.0");
    expect(err instanceof ManifestSignatureInvalidError).toBe(true);
  });
});

// ─── ManifestVersionConflictError ────────────────────────────────────────────

describe("ManifestVersionConflictError", () => {
  test("is an instance of Error", () => {
    const err = new ManifestVersionConflictError("agent.x", "1.0.0", "active");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ManifestVersionConflictError", () => {
    const err = new ManifestVersionConflictError("agent.x", "1.0.0", "active");
    expect(err.name).toBe("ManifestVersionConflictError");
  });

  test("name field stored correctly", () => {
    const err = new ManifestVersionConflictError("vauban.bastion.v1", "0.1.0", "deprecated");
    expect(err.name).toBe("ManifestVersionConflictError");
  });

  test("version field stored correctly", () => {
    const err = new ManifestVersionConflictError("agent.z", "4.2.1", "active");
    expect(err.version).toBe("4.2.1");
  });

  test("existingStatus field stored correctly", () => {
    const err = new ManifestVersionConflictError("agent.x", "1.0.0", "revoked");
    expect(err.existingStatus).toBe("revoked");
  });

  test("message contains name@version", () => {
    const err = new ManifestVersionConflictError("vauban.agent.foo", "1.0.0", "active");
    expect(err.message).toContain("vauban.agent.foo@1.0.0");
  });

  test("message contains existingStatus", () => {
    const err = new ManifestVersionConflictError("agent.x", "1.0.0", "deprecated");
    expect(err.message).toContain("deprecated");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new ManifestVersionConflictError("a", "0.0.1", "active");
    expect(err instanceof ManifestVersionConflictError).toBe(true);
  });
});

// ─── ManifestComplianceConflictError ─────────────────────────────────────────

describe("ManifestComplianceConflictError", () => {
  test("is an instance of Error", () => {
    const err = new ManifestComplianceConflictError("agent.x", "1.0.0", "I-S1-2 violation");
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ManifestComplianceConflictError", () => {
    const err = new ManifestComplianceConflictError("a", "1.0.0", "v");
    expect(err.name).toBe("ManifestComplianceConflictError");
  });

  test("name field stored correctly", () => {
    const err = new ManifestComplianceConflictError("vauban.cc.audit", "2.0.0", "v");
    expect(err.name).toBe("ManifestComplianceConflictError");
  });

  test("version field stored correctly", () => {
    const err = new ManifestComplianceConflictError("agent", "5.0.1", "v");
    expect(err.version).toBe("5.0.1");
  });

  test("violation field stored correctly", () => {
    const err = new ManifestComplianceConflictError(
      "a",
      "1.0.0",
      "production tier requires strict mode",
    );
    expect(err.violation).toBe("production tier requires strict mode");
  });

  test("message contains name@version", () => {
    const err = new ManifestComplianceConflictError("vauban.forge.jobs", "1.2.0", "v");
    expect(err.message).toContain("vauban.forge.jobs@1.2.0");
  });

  test("message contains violation text", () => {
    const err = new ManifestComplianceConflictError("a", "1.0.0", "GDPR art6 missing");
    expect(err.message).toContain("GDPR art6 missing");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new ManifestComplianceConflictError("a", "0.0.1", "v");
    expect(err instanceof ManifestComplianceConflictError).toBe(true);
  });
});

// ─── ManifestValidationError ──────────────────────────────────────────────────

describe("ManifestValidationError", () => {
  test("is an instance of Error", () => {
    const err = new ManifestValidationError([]);
    expect(err).toBeInstanceOf(Error);
  });

  test("name is ManifestValidationError", () => {
    const err = new ManifestValidationError([]);
    expect(err.name).toBe("ManifestValidationError");
  });

  test("violations field stores provided errors", () => {
    const violations: ComplianceError[] = [
      { code: "E1", description: "desc1" },
      { code: "E2", description: "desc2" },
    ];
    const err = new ManifestValidationError(violations);
    expect(err.violations).toHaveLength(2);
    expect(err.violations[0].code).toBe("E1");
    expect(err.violations[1].description).toBe("desc2");
  });

  test("message includes violation count for multiple violations", () => {
    const violations: ComplianceError[] = [
      { code: "E1", description: "d1" },
      { code: "E2", description: "d2" },
      { code: "E3", description: "d3" },
    ];
    const err = new ManifestValidationError(violations);
    expect(err.message).toContain("3");
  });

  test("message includes violation count for single violation", () => {
    const violations: ComplianceError[] = [{ code: "E1", description: "only one" }];
    const err = new ManifestValidationError(violations);
    expect(err.message).toContain("1");
  });

  test("empty violations array is valid", () => {
    const err = new ManifestValidationError([]);
    expect(err.violations).toHaveLength(0);
    expect(err.message).toContain("0");
  });

  test("instanceof check is preserved after setPrototypeOf", () => {
    const err = new ManifestValidationError([]);
    expect(err instanceof ManifestValidationError).toBe(true);
  });
});

// ─── SUPPORTED_TIERS constant ─────────────────────────────────────────────────

describe("SUPPORTED_TIERS constant", () => {
  test("contains dev tier", () => {
    expect(SUPPORTED_TIERS).toContain("dev");
  });

  test("contains test tier", () => {
    expect(SUPPORTED_TIERS).toContain("test");
  });

  test("contains pilot tier", () => {
    expect(SUPPORTED_TIERS).toContain("pilot");
  });

  test("contains production tier", () => {
    expect(SUPPORTED_TIERS).toContain("production");
  });

  test("contains internal tier", () => {
    expect(SUPPORTED_TIERS).toContain("internal");
  });

  test("contains legacy tier", () => {
    expect(SUPPORTED_TIERS).toContain("legacy");
  });

  test("has exactly 6 tiers", () => {
    expect(SUPPORTED_TIERS).toHaveLength(6);
  });
});

// ─── Cross-type instanceof checks ────────────────────────────────────────────

describe("cross-type instanceof isolation", () => {
  test("ManifestNotFoundError is not ManifestSignatureInvalidError", () => {
    const err = new ManifestNotFoundError("a", "1.0.0");
    expect(err instanceof ManifestSignatureInvalidError).toBe(false);
  });

  test("ManifestVersionConflictError is not ManifestValidationError", () => {
    const err = new ManifestVersionConflictError("a", "1.0.0", "active");
    expect(err instanceof ManifestValidationError).toBe(false);
  });

  test("ManifestComplianceConflictError is not ManifestNotFoundError", () => {
    const err = new ManifestComplianceConflictError("a", "1.0.0", "v");
    expect(err instanceof ManifestNotFoundError).toBe(false);
  });
});
