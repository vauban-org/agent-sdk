/**
 * MultiModalObservation — sprint-525:quick-6
 *
 * Typed container for observations that include non-text content (image, audio,
 * document).  The ORIENT phase detects multimodal observations via `isMultiModal`
 * and converts them to the Anthropic Messages API content-block format so Claude
 * Opus 4 can process vision/audio inputs natively.
 *
 * Anthropic Messages API reference:
 * https://docs.anthropic.com/api/messages
 *
 * @public
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A base64-encoded image source (jpg / png / gif / webp) or an external URL.
 * Matches the Anthropic `image` content block `source` field.
 */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Audio media types supported by Claude's audio input capability.
 */
export type AudioMediaType = "audio/ogg" | "audio/wav" | "audio/mp3" | "audio/mpeg" | "audio/webm";

/**
 * A multimodal observation may carry text alongside any combination of image,
 * audio, and document inputs.  All non-text fields are optional; at least one
 * must be present for `isMultiModal` to return `true`.
 */
export interface MultiModalObservation {
  /** Plain-text portion of the observation (always included when available). */
  text?: string;
  /** Base64-encoded image (jpg / png / gif / webp). */
  imageBase64?: string;
  /** MIME type for `imageBase64`. Defaults to `image/jpeg` if absent. */
  imageMediaType?: ImageMediaType;
  /** Base64-encoded audio clip (ogg / wav / mp3 / webm). */
  audioBase64?: string;
  /** MIME type for `audioBase64`. Defaults to `audio/ogg` if absent. */
  audioMediaType?: AudioMediaType;
  /** Publicly accessible URL to a PDF document. */
  documentUrl?: string;
}

// ---------------------------------------------------------------------------
// Anthropic content-block types (subset of Messages API)
// These mirror the official SDK types exactly so no extra dependency is needed.
// ---------------------------------------------------------------------------

/** Plain-text content block. */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/** Base64 image content block (Messages API). */
export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: ImageMediaType;
    data: string;
  };
}

/** URL-referenced document content block (Messages API). */
export interface AnthropicDocumentBlock {
  type: "document";
  source: {
    type: "url";
    url: string;
  };
}

/** Discriminated union of all supported Anthropic content blocks. */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the observation contains at least one non-text channel
 * (image, audio, or document).
 *
 * The ORIENT phase calls this before deciding whether to use a vision-capable
 * model.  Text-only observations short-circuit to a lightweight completion.
 */
export function isMultiModal(obs: unknown): obs is MultiModalObservation {
  return (
    typeof obs === "object" &&
    obs !== null &&
    ("imageBase64" in obs || "audioBase64" in obs || "documentUrl" in obs)
  );
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Maps a `MultiModalObservation` to an ordered array of Anthropic Messages API
 * content blocks suitable for inclusion in a `messages[].content` array.
 *
 * Ordering (Anthropic recommends text first, then media):
 *   1. `text` → `TextBlock`
 *   2. `imageBase64` → `ImageBlock` (base64 source)
 *   3. `documentUrl` → `DocumentBlock` (URL source)
 *
 * Audio note: the Anthropic Messages API does not yet expose a first-class
 * audio content block in the public spec (as of April 2026).  Audio is
 * surfaced as a text block carrying a data-URI so callers can substitute their
 * own handler when native audio support ships.
 *
 * @throws {TypeError} when `obs` carries neither text nor any media field.
 */
export function multiModalToAnthropicContent(
  obs: MultiModalObservation,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  // 1. Text block (always first)
  if (obs.text !== undefined && obs.text.length > 0) {
    blocks.push({ type: "text", text: obs.text });
  }

  // 2. Image block
  if (obs.imageBase64 !== undefined) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: obs.imageMediaType ?? "image/jpeg",
        data: obs.imageBase64,
      },
    });
  }

  // 3. Audio — surfaced as text data-URI pending native API support
  if (obs.audioBase64 !== undefined) {
    const mimeType: AudioMediaType = obs.audioMediaType ?? "audio/ogg";
    blocks.push({
      type: "text",
      text: `data:${mimeType};base64,${obs.audioBase64}`,
    });
  }

  // 4. Document block (URL source)
  if (obs.documentUrl !== undefined) {
    blocks.push({
      type: "document",
      source: {
        type: "url",
        url: obs.documentUrl,
      },
    });
  }

  if (blocks.length === 0) {
    throw new TypeError(
      "MultiModalObservation must carry at least one non-empty field (text, imageBase64, audioBase64, or documentUrl)",
    );
  }

  return blocks;
}
