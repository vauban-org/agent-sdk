import { describe, expect, it } from "vitest";
import { toSdkEscalationLevel } from "../src/types/escalation-mapping.js";

describe("toSdkEscalationLevel", () => {
  it("maps L0 to L1_autonomous", () => {
    expect(toSdkEscalationLevel("L0")).toBe("L1_autonomous");
  });

  it("maps L1 to L1_autonomous", () => {
    expect(toSdkEscalationLevel("L1")).toBe("L1_autonomous");
  });

  it("maps L2 to L2_async_review", () => {
    expect(toSdkEscalationLevel("L2")).toBe("L2_async_review");
  });

  it("maps L3 to L3_hitl_required", () => {
    expect(toSdkEscalationLevel("L3")).toBe("L3_hitl_required");
  });

  it("L0 and L1 both map to the same value (L1_autonomous)", () => {
    expect(toSdkEscalationLevel("L0")).toBe(toSdkEscalationLevel("L1"));
  });

  it("return type is a valid SdkEscalationLevel string", () => {
    const result = toSdkEscalationLevel("L1");
    expect(typeof result).toBe("string");
    expect(result).toBe("L1_autonomous");
  });

  it("L2 does NOT return L1_autonomous", () => {
    expect(toSdkEscalationLevel("L2")).not.toBe("L1_autonomous");
  });

  it("L3 does NOT return L2_async_review", () => {
    expect(toSdkEscalationLevel("L3")).not.toBe("L2_async_review");
  });
});
