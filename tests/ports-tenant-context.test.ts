import { describe, expect, it } from "vitest";
import {
  DegradedModeExhaustedError,
  InvalidGlacisAttestationError,
  TenantNotFoundError,
} from "../src/ports/tenant-context.js";
import type {
  DegradedMetrics,
  DegradedModeEnteredClaim,
  DegradedModeExhaustedClaim,
  TenantContext,
  TenantMode,
} from "../src/ports/tenant-context.js";

// ─── TenantNotFoundError ───────────────────────────────────────────────────────

describe("TenantNotFoundError", () => {
  it("is instanceof Error", () => {
    const err = new TenantNotFoundError("tenant-42");
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "TenantNotFoundError"', () => {
    const err = new TenantNotFoundError("tenant-42");
    expect(err.name).toBe("TenantNotFoundError");
  });

  it("message contains the tenantId", () => {
    const err = new TenantNotFoundError("tenant-xyz");
    expect(err.message).toContain("tenant-xyz");
  });

  it("sets tenantId field correctly", () => {
    const err = new TenantNotFoundError("tenant-abc");
    expect(err.tenantId).toBe("tenant-abc");
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new TenantNotFoundError("tenant-001");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(TenantNotFoundError);
  });

  it("inherits prototype correctly across transpilation boundaries", () => {
    const err = new TenantNotFoundError("t1");
    expect(Object.getPrototypeOf(err)).toBe(TenantNotFoundError.prototype);
  });

  it("has a stack trace", () => {
    const err = new TenantNotFoundError("t2");
    expect(err.stack).toBeTruthy();
  });
});

// ─── DegradedModeExhaustedError ────────────────────────────────────────────────

describe("DegradedModeExhaustedError", () => {
  const CAP = 30 * 86400; // 2 592 000 seconds

  it("is instanceof Error", () => {
    const err = new DegradedModeExhaustedError("t-1", CAP + 100, CAP);
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "DegradedModeExhaustedError"', () => {
    const err = new DegradedModeExhaustedError("t-1", CAP + 1, CAP);
    expect(err.name).toBe("DegradedModeExhaustedError");
  });

  it("message contains tenantId", () => {
    const err = new DegradedModeExhaustedError("tenant-special", CAP + 1, CAP);
    expect(err.message).toContain("tenant-special");
  });

  it("message contains totalDegradedSeconds", () => {
    const total = CAP + 500;
    const err = new DegradedModeExhaustedError("t-2", total, CAP);
    expect(err.message).toContain(String(total));
  });

  it("message contains capSeconds", () => {
    const err = new DegradedModeExhaustedError("t-3", CAP + 1, CAP);
    expect(err.message).toContain(String(CAP));
  });

  it("sets tenantId, totalDegradedSeconds, capSeconds correctly", () => {
    const total = CAP + 3600;
    const err = new DegradedModeExhaustedError("t-4", total, CAP);
    expect(err.tenantId).toBe("t-4");
    expect(err.totalDegradedSeconds).toBe(total);
    expect(err.capSeconds).toBe(CAP);
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new DegradedModeExhaustedError("t-5", CAP + 1, CAP);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(DegradedModeExhaustedError);
  });

  it("inherits prototype correctly", () => {
    const err = new DegradedModeExhaustedError("t-6", CAP + 1, CAP);
    expect(Object.getPrototypeOf(err)).toBe(DegradedModeExhaustedError.prototype);
  });

  it("message mentions 30 days", () => {
    const err = new DegradedModeExhaustedError("t-7", CAP + 1, CAP);
    expect(err.message).toContain("30 days");
  });
});

// ─── InvalidGlacisAttestationError ────────────────────────────────────────────

describe("InvalidGlacisAttestationError", () => {
  it("is instanceof Error", () => {
    const err = new InvalidGlacisAttestationError("t-a", "expired");
    expect(err).toBeInstanceOf(Error);
  });

  it('.name is "InvalidGlacisAttestationError"', () => {
    const err = new InvalidGlacisAttestationError("t-a", "expired");
    expect(err.name).toBe("InvalidGlacisAttestationError");
  });

  it("message contains tenantId", () => {
    const err = new InvalidGlacisAttestationError("tenant-99", "nullifier mismatch");
    expect(err.message).toContain("tenant-99");
  });

  it("message contains reason", () => {
    const err = new InvalidGlacisAttestationError("t-b", "block too old");
    expect(err.message).toContain("block too old");
  });

  it("sets tenantId and reason fields correctly", () => {
    const err = new InvalidGlacisAttestationError("t-c", "txRef not found");
    expect(err.tenantId).toBe("t-c");
    expect(err.reason).toBe("txRef not found");
  });

  it("can be caught as Error", () => {
    let caught: unknown;
    try {
      throw new InvalidGlacisAttestationError("t-d", "invalid signature");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidGlacisAttestationError);
  });

  it("inherits prototype correctly", () => {
    const err = new InvalidGlacisAttestationError("t-e", "reason");
    expect(Object.getPrototypeOf(err)).toBe(InvalidGlacisAttestationError.prototype);
  });

  it("has a stack trace", () => {
    const err = new InvalidGlacisAttestationError("t-f", "reason");
    expect(err.stack).toBeTruthy();
  });
});

// ─── TenantContext structural tests ───────────────────────────────────────────

describe("TenantContext type shape", () => {
  it("accepts a minimal verified TenantContext", () => {
    const ctx: TenantContext = {
      canonical_id: "0xdeadbeef",
      mode: "verified",
      kek_id: "kms-ref-001",
      jurisdictions: ["FR.v1"],
      verified_human: true,
    };
    expect(ctx.mode).toBe("verified");
    expect(ctx.verified_human).toBe(true);
    expect(ctx.jurisdictions).toContain("FR.v1");
  });

  it("accepts a degraded_verified TenantContext with degraded_since", () => {
    const ctx: TenantContext = {
      canonical_id: "0xabcdef",
      mode: "degraded_verified",
      kek_id: "kms-ref-002",
      jurisdictions: ["EU.v1"],
      verified_human: true,
      degraded_since: new Date("2026-05-01T00:00:00Z"),
    };
    expect(ctx.mode).toBe("degraded_verified");
    expect(ctx.degraded_since).toBeInstanceOf(Date);
  });

  it("accepts an unverified TenantContext", () => {
    const ctx: TenantContext = {
      canonical_id: "0x000",
      mode: "unverified",
      kek_id: "kms-ref-003",
      jurisdictions: [],
      verified_human: false,
    };
    expect(ctx.mode).toBe("unverified");
    expect(ctx.verified_human).toBe(false);
  });

  it("accepts glacis_attestation_ref in verified mode", () => {
    const ctx: TenantContext = {
      canonical_id: "0x1234",
      mode: "verified",
      kek_id: "kms-ref-004",
      jurisdictions: ["FR.v1", "EU.v1"],
      verified_human: true,
      glacis_attestation_ref: "0xmaintx123",
    };
    expect(ctx.glacis_attestation_ref).toBe("0xmaintx123");
  });
});

// ─── TenantMode type coverage ──────────────────────────────────────────────────

describe("TenantMode type coverage", () => {
  it("all three TenantMode values are valid string literals", () => {
    const modes: TenantMode[] = ["verified", "degraded_verified", "unverified"];
    expect(modes).toHaveLength(3);
    for (const m of modes) {
      expect(typeof m).toBe("string");
    }
  });
});

// ─── DegradedMetrics structural tests ─────────────────────────────────────────

describe("DegradedMetrics type shape", () => {
  it("accepts valid DegradedMetrics object", () => {
    const metrics: DegradedMetrics = {
      total_degraded_last_90d: 86400,
      episodes_count: 2,
      pct_time_degraded: 1.11,
    };
    expect(metrics.episodes_count).toBe(2);
    expect(metrics.pct_time_degraded).toBeCloseTo(1.11);
  });

  it("accepts zero-degraded metrics", () => {
    const metrics: DegradedMetrics = {
      total_degraded_last_90d: 0,
      episodes_count: 0,
      pct_time_degraded: 0,
    };
    expect(metrics.total_degraded_last_90d).toBe(0);
  });
});

// ─── DegradedModeEnteredClaim structural tests ────────────────────────────────

describe("DegradedModeEnteredClaim type shape", () => {
  it("accepts a valid claim with required fields", () => {
    const claim: DegradedModeEnteredClaim = {
      tenant_id: "tenant-aaa",
      reason: "glacis.downtime",
      entered_at: new Date(),
    };
    expect(claim.reason).toBe("glacis.downtime");
    expect(claim.entered_at).toBeInstanceOf(Date);
  });

  it("accepts a claim with optional window_remaining_seconds", () => {
    const claim: DegradedModeEnteredClaim = {
      tenant_id: "tenant-bbb",
      reason: "temporary.mitigation",
      entered_at: new Date(),
      window_remaining_seconds: 86400 * 25,
    };
    expect(claim.window_remaining_seconds).toBe(86400 * 25);
  });
});

// ─── DegradedModeExhaustedClaim structural tests ──────────────────────────────

describe("DegradedModeExhaustedClaim type shape", () => {
  it("accepts a valid exhausted claim", () => {
    const claim: DegradedModeExhaustedClaim = {
      tenant_id: "tenant-ccc",
      total_degraded_90d_seconds: 30 * 86400 + 1,
      cap_seconds: 30 * 86400,
      fallback_mode: "unverified",
      exhausted_at: new Date(),
    };
    expect(claim.fallback_mode).toBe("unverified");
    expect(claim.cap_seconds).toBe(30 * 86400);
  });
});
