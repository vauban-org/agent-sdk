import { describe, expect, it, vi } from "vitest";
import type { Span } from "@opentelemetry/api";
import { setGenAiAttributes, VAUBAN_ASSURANCE_GRADE } from "./attributes.js";

describe("vauban.assurance.grade attribute", () => {
  it("setGenAiAttributes sets the grade", () => {
    const setAttribute = vi.fn();
    const span = { setAttribute } as unknown as Span;
    setGenAiAttributes(span, { "vauban.assurance.grade": "A1" });
    expect(setAttribute).toHaveBeenCalledWith("vauban.assurance.grade", "A1");
  });
  it("constant matches the attribute key", () => {
    expect(VAUBAN_ASSURANCE_GRADE).toBe("vauban.assurance.grade");
  });
});
