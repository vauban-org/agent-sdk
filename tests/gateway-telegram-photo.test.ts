/**
 * tests/gateway-telegram-photo.test.ts ; Beyond-Hermes Vera multimodal (photo
 * ingestion). The Telegram gateway adapter, with `acceptPhotos`, downloads the
 * largest photo size and forwards it as an InboundMessage image attachment with
 * the caption as text. With the flag off, a photo is skipped (the existing
 * behaviour). pickLargestPhoto is unit-tested pure.
 *
 * NOTE: the agent-loop wire-through (InboundMessage.attachments ->
 * ChatMessage.attachments via the InstructionInbox) is a separate slice ; this
 * covers the ingestion edge only.
 */

import { describe, expect, it } from "vitest";
import {
  createTelegramAdapter,
  pickLargestPhoto,
} from "../src/remote/gateway/adapters/telegram.js";
import type { InboundMessage } from "../src/remote/gateway/types.js";

describe("pickLargestPhoto", () => {
  it("returns null for an empty array", () => {
    expect(pickLargestPhoto([])).toBeNull();
  });
  it("picks the max by file_size", () => {
    expect(
      pickLargestPhoto([
        { file_id: "a", file_size: 100 },
        { file_id: "b", file_size: 5000 },
        { file_id: "c", file_size: 500 },
      ])?.file_id,
    ).toBe("b");
  });
  it("falls back to pixel area when file_size is absent", () => {
    expect(
      pickLargestPhoto([
        { file_id: "a", width: 10, height: 10 },
        { file_id: "b", width: 100, height: 100 },
      ])?.file_id,
    ).toBe("b");
  });
});

const photoUpdate = {
  update_id: 1,
  message: {
    chat: { id: 123 },
    from: { id: 456 },
    caption: "what is in this image?",
    photo: [
      { file_id: "small", file_size: 100, width: 90, height: 90 },
      { file_id: "large", file_size: 5000, width: 1280, height: 1280 },
    ],
  },
};

const IMG_BYTES = [0xff, 0xd8, 0xff, 0xe0];
const IMG_B64 = Buffer.from(IMG_BYTES).toString("base64");

/** A fetch mock that serves the given first batch of updates, then []. */
function makeFetch(firstBatch: unknown[]): typeof fetch {
  let served = 0;
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/getUpdates")) {
      const result = served++ === 0 ? firstBatch : [];
      if (served > 1) await new Promise((r) => setTimeout(r, 20)); // avoid hot spin
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
      });
    }
    if (u.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/large.jpg" } }), {
        status: 200,
      });
    }
    if (u.includes("/file/bot")) {
      return new Response(new Uint8Array(IMG_BYTES), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

describe("Telegram gateway photo ingestion", () => {
  it("downloads the largest photo + forwards it as an image attachment", async () => {
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["123"],
      fetchImpl: makeFetch([photoUpdate]),
      apiBase: "https://tg.test",
      acceptPhotos: true,
    });
    let resolveGot!: (m: InboundMessage) => void;
    const got = new Promise<InboundMessage>((r) => {
      resolveGot = r;
    });
    await adapter.start((m) => resolveGot(m));
    const msg = await got;
    await adapter.stop();

    expect(msg.text).toBe("what is in this image?");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]).toEqual({
      kind: "image",
      mediaType: "image/jpeg",
      dataBase64: IMG_B64,
    });
  });

  it("skips a photo when acceptPhotos is off (forwards a following text only)", async () => {
    const textUpdate = {
      update_id: 2,
      message: { chat: { id: 123 }, from: { id: 456 }, text: "hello" },
    };
    const adapter = createTelegramAdapter({
      botToken: "T",
      allowedChatIds: ["123"],
      fetchImpl: makeFetch([photoUpdate, textUpdate]),
      apiBase: "https://tg.test",
      // acceptPhotos omitted => false
    });
    let resolveGot!: (m: InboundMessage) => void;
    const got = new Promise<InboundMessage>((r) => {
      resolveGot = r;
    });
    await adapter.start((m) => resolveGot(m));
    const msg = await got;
    await adapter.stop();

    // The photo was skipped ; the first message the agent sees is the text.
    expect(msg.text).toBe("hello");
    expect(msg.attachments).toBeUndefined();
  });
});
