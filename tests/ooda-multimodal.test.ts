/**
 * Tests for MultiModalObservation types and helpers — sprint-525:quick-6.
 *
 * Covers:
 *   - isMultiModal type guard (text-only → false, media fields → true)
 *   - multiModalToAnthropicContent output shape for image, audio, document
 *   - error when no content at all
 */

import { describe, expect, it } from "vitest";
import {
  isMultiModal,
  multiModalToAnthropicContent,
} from "../src/orchestration/ooda/multimodal.js";

// ---------------------------------------------------------------------------
// isMultiModal
// ---------------------------------------------------------------------------

describe("isMultiModal", () => {
  it("returns false for null", () => {
    expect(isMultiModal(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isMultiModal(undefined)).toBe(false);
  });

  it("returns false for a plain string", () => {
    expect(isMultiModal("hello")).toBe(false);
  });

  it("returns false for text-only observation (no media keys)", () => {
    expect(isMultiModal({ text: "hello world" })).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isMultiModal({})).toBe(false);
  });

  it("returns true when imageBase64 is present", () => {
    expect(isMultiModal({ imageBase64: "abc123" })).toBe(true);
  });

  it("returns true when audioBase64 is present", () => {
    expect(isMultiModal({ audioBase64: "xyz789" })).toBe(true);
  });

  it("returns true when documentUrl is present", () => {
    expect(isMultiModal({ documentUrl: "https://example.com/doc.pdf" })).toBe(true);
  });

  it("returns true for combined text + image", () => {
    expect(isMultiModal({ text: "describe this", imageBase64: "data" })).toBe(true);
  });

  it("returns true when all three media fields are present", () => {
    expect(
      isMultiModal({
        text: "full observation",
        imageBase64: "img",
        audioBase64: "aud",
        documentUrl: "https://x.com/doc.pdf",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// multiModalToAnthropicContent
// ---------------------------------------------------------------------------

describe("multiModalToAnthropicContent", () => {
  it("text-only → single TextBlock", () => {
    const blocks = multiModalToAnthropicContent({ text: "hello" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "text", text: "hello" });
  });

  it("imageBase64 + text → [TextBlock, ImageBlock]", () => {
    const blocks = multiModalToAnthropicContent({
      text: "describe this chart",
      imageBase64: "aGVsbG8=",
      imageMediaType: "image/png",
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "describe this chart" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "aGVsbG8=",
      },
    });
  });

  it("imageBase64 without mediaType defaults to image/jpeg", () => {
    const blocks = multiModalToAnthropicContent({ imageBase64: "abc" });
    expect(blocks).toHaveLength(1);
    const img = blocks[0] as { type: string; source: { media_type: string } };
    expect(img.source.media_type).toBe("image/jpeg");
  });

  it("audioBase64 → text block with data-URI (pending native support)", () => {
    const blocks = multiModalToAnthropicContent({
      audioBase64: "oggdata",
      audioMediaType: "audio/ogg",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      text: "data:audio/ogg;base64,oggdata",
    });
  });

  it("audioBase64 without mediaType defaults to audio/ogg", () => {
    const blocks = multiModalToAnthropicContent({ audioBase64: "data" });
    const tb = blocks[0] as { type: string; text: string };
    expect(tb.text).toMatch(/^data:audio\/ogg;base64,/);
  });

  it("documentUrl → DocumentBlock", () => {
    const blocks = multiModalToAnthropicContent({
      documentUrl: "https://example.com/report.pdf",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "document",
      source: {
        type: "url",
        url: "https://example.com/report.pdf",
      },
    });
  });

  it("all fields combined → ordered blocks (text, image, audio, document)", () => {
    const blocks = multiModalToAnthropicContent({
      text: "full obs",
      imageBase64: "imgdata",
      audioBase64: "auddata",
      documentUrl: "https://x.com/a.pdf",
    });
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(blocks[1]).toMatchObject({ type: "image" });
    // audio → text data-URI
    expect(blocks[2]).toMatchObject({ type: "text" });
    expect((blocks[2] as { type: string; text: string }).text).toMatch(
      /^data:audio\//,
    );
    expect(blocks[3]).toMatchObject({ type: "document" });
  });

  it("throws TypeError when observation has no content at all", () => {
    expect(() => multiModalToAnthropicContent({})).toThrow(TypeError);
  });

  it("throws TypeError when text is empty string and no media fields", () => {
    expect(() => multiModalToAnthropicContent({ text: "" })).toThrow(TypeError);
  });
});
