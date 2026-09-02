/**
 * execution-planner certificate (ADR-ECO-093) ; behaviour + PoC-33 parity.
 *
 * Asserts the SDK certificate machinery reproduces the research composite (PoC-33, real
 * Binance L2 book): fail-closed production_ready gating, honesty about non-admitted layers,
 * discrimination (a blocked subject), order-independent determinism, and the A0/A1/A3 ladder
 * (tampering production_ready OR any nested layer field -> A0).
 */
import { describe, expect, it } from "vitest";

import {
  type CertificateLayer,
  type CompositeCertificateInput,
  GovernanceError,
  certificateCore,
  executionPlannerCertificate,
  gradeExecutionCertificate,
} from "../../src/provable-planner/index.js";

const ADR = "ADR-ECO-093";

// PoC-33 BTC depth_aware: 4 admitted layers pass, regret_bound not-admitted.
const READY_LAYERS: CertificateLayer[] = [
  {
    name: "decision_a3",
    admitted: true,
    passed: true,
    detail: { clean_grade: "A3" },
  },
  {
    name: "adversarial",
    admitted: true,
    passed: true,
    detail: { survives: true, n_refuters: 6 },
  },
  {
    name: "robustness",
    admitted: true,
    passed: true,
    detail: { classification: "ROBUST" },
  },
  {
    name: "determinism",
    admitted: true,
    passed: true,
    detail: { portable: true, mismatches: 0 },
  },
  {
    name: "regret_bound",
    admitted: false,
    passed: false,
    detail: { reason: "no NWF structure" },
  },
];

// PoC-33 inverse-depth control: adversarial + robustness fail.
const CONTROL_LAYERS: CertificateLayer[] = [
  {
    name: "decision_a3",
    admitted: true,
    passed: true,
    detail: { clean_grade: "A3" },
  },
  {
    name: "adversarial",
    admitted: true,
    passed: false,
    detail: { survives: false },
  },
  {
    name: "robustness",
    admitted: true,
    passed: false,
    detail: { classification: "FRAGILE" },
  },
  {
    name: "determinism",
    admitted: true,
    passed: true,
    detail: { portable: true, mismatches: 0 },
  },
  {
    name: "regret_bound",
    admitted: false,
    passed: false,
    detail: { reason: "no NWF structure" },
  },
];

const input = (subject: string, layers: CertificateLayer[]): CompositeCertificateInput => ({
  subject,
  dataFingerprint: "deadbeef",
  layers,
});

describe("certificateCore ; aggregation", () => {
  it("is production_ready when every admitted layer passes", () => {
    const c = certificateCore(input("btc_depth_aware", READY_LAYERS));
    expect(c.productionReady).toBe(true);
    expect(c.admittedLayers).toEqual(["adversarial", "decision_a3", "determinism", "robustness"]);
    expect(c.notAdmittedLayers).toEqual(["regret_bound"]);
  });

  it("does NOT gate on a non-admitted layer (honesty)", () => {
    // regret_bound is admitted:false, passed:false ; must not block readiness
    const c = certificateCore(input("btc_depth_aware", READY_LAYERS));
    expect(c.productionReady).toBe(true);
    expect(c.notAdmittedLayers).toContain("regret_bound");
  });

  it("blocks the negative control (discrimination)", () => {
    const c = certificateCore(input("btc_inverse_depth", CONTROL_LAYERS));
    expect(c.productionReady).toBe(false);
  });

  it("fail-closed when no layer is admitted", () => {
    const c = certificateCore(
      input("x", [{ name: "regret_bound", admitted: false, passed: false, detail: {} }]),
    );
    expect(c.productionReady).toBe(false);
  });

  it("fail-closed when any admitted layer fails", () => {
    const layers = READY_LAYERS.map((l) =>
      l.name === "determinism" ? { ...l, passed: false } : l,
    );
    expect(certificateCore(input("x", layers)).productionReady).toBe(false);
  });

  it("is order-independent (deterministic canonical layer order)", () => {
    const a = certificateCore(input("x", READY_LAYERS));
    const b = certificateCore(input("x", [...READY_LAYERS].reverse()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("executionPlannerCertificate ; A3 ladder + governance", () => {
  it("re-executes byte-identically -> A3 (external verifier)", () => {
    const { claim } = executionPlannerCertificate({
      input: input("btc", READY_LAYERS),
      adrEco: ADR,
    });
    expect(claim.output.productionReady).toBe(true);
    expect(gradeExecutionCertificate(claim, true)).toBe("A3");
    expect(gradeExecutionCertificate(claim, false)).toBe("A1");
  });

  it("tampering production_ready -> A0", () => {
    const { claim } = executionPlannerCertificate({
      input: input("btc", READY_LAYERS),
      adrEco: ADR,
    });
    const tampered = JSON.parse(JSON.stringify(claim));
    tampered.output.productionReady = false;
    expect(gradeExecutionCertificate(tampered, true)).toBe("A0");
  });

  it("tampering a nested layer field -> A0", () => {
    const { claim } = executionPlannerCertificate({
      input: input("btc", READY_LAYERS),
      adrEco: ADR,
    });
    const tampered = JSON.parse(JSON.stringify(claim));
    const robustness = tampered.output.layers.find(
      (l: CertificateLayer) => l.name === "robustness",
    );
    robustness.detail.classification = "ROBUST_FAKE";
    expect(gradeExecutionCertificate(tampered, true)).toBe("A0");
  });

  it("emits one audit step bound to the adrEco", () => {
    const { auditStep } = executionPlannerCertificate({
      input: input("btc", READY_LAYERS),
      adrEco: ADR,
    });
    expect(auditStep.adrEco).toBe(ADR);
    expect(auditStep.type).toBe("guard_check");
    expect(auditStep.outputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires a non-empty adrEco (ADR-traceability)", () => {
    expect(() =>
      executionPlannerCertificate({
        input: input("btc", READY_LAYERS),
        adrEco: "",
      }),
    ).toThrow(GovernanceError);
  });
});
