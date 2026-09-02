/**
 * Tests for buildOrientPrompt (Vague 1.B.5).
 */

import { describe, expect, it } from "vitest";
import { buildOrientPrompt } from "../src/prompts/build-orient-prompt.js";

describe("buildOrientPrompt", () => {
  it("returns system and user strings from minimal opts", () => {
    const result = buildOrientPrompt({
      systemPrompt: "You are a test agent.",
      userContext: "Observe: nothing.",
    });
    expect(result.system).toBe("You are a test agent.");
    expect(result.user).toBe("Observe: nothing.");
  });

  it("injects jsonSchema into the system prompt when provided", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const result = buildOrientPrompt({
      systemPrompt: "You are a test agent.",
      userContext: "ctx",
      jsonSchema: schema,
    });
    expect(result.system).toContain("Output JSON schema:");
    expect(result.system).toContain('"answer"');
  });

  it("does NOT inject schema block when jsonSchema is omitted", () => {
    const result = buildOrientPrompt({
      systemPrompt: "base",
      userContext: "ctx",
    });
    expect(result.system).toBe("base");
  });

  it("prepends recentMemory as a bullet list in user prompt", () => {
    const result = buildOrientPrompt({
      systemPrompt: "sys",
      userContext: "observation",
      recentMemory: ["memory A", "memory B"],
    });
    expect(result.user).toContain("- memory A");
    expect(result.user).toContain("- memory B");
    expect(result.user).toContain("observation");
  });

  it("truncates userContext at maxContextChars and appends truncation marker", () => {
    const longContext = "x".repeat(3000);
    const result = buildOrientPrompt({
      systemPrompt: "sys",
      userContext: longContext,
      maxContextChars: 100,
    });
    expect(result.user).toContain("[...truncated]");
    // Should be capped at 100 chars + marker, well below 3000
    expect(result.user.length).toBeLessThan(3000);
  });

  it("does not truncate when userContext is within maxContextChars", () => {
    const ctx = "short context";
    const result = buildOrientPrompt({
      systemPrompt: "sys",
      userContext: ctx,
      maxContextChars: 2500,
    });
    expect(result.user).not.toContain("[...truncated]");
    expect(result.user).toBe(ctx);
  });

  it("uses default cap of 2500 chars when maxContextChars is omitted", () => {
    const longContext = "a".repeat(3000);
    const result = buildOrientPrompt({
      systemPrompt: "sys",
      userContext: longContext,
    });
    expect(result.user).toContain("[...truncated]");
  });

  it("handles empty recentMemory array without adding memory block", () => {
    const result = buildOrientPrompt({
      systemPrompt: "sys",
      userContext: "ctx",
      recentMemory: [],
    });
    expect(result.user).toBe("ctx");
    expect(result.user).not.toContain("Recent memory:");
  });
});
