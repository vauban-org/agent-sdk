import { describe, expect, it } from "vitest";
import { AcpFrameDecoder, encodeAcpFrame } from "./framing.js";
import { parseAcpMessage, serializeAcpMessage } from "./jsonrpc.js";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("encodeAcpFrame", () => {
  it("termine le message par un seul saut de ligne", () => {
    const frame = encodeAcpFrame('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(frame).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  });
});

describe("AcpFrameDecoder", () => {
  it("restitue une ligne complete recue en un seul chunk", () => {
    const decoder = new AcpFrameDecoder();
    const lines = decoder.push(utf8('{"a":1}\n'));
    expect(lines).toEqual(['{"a":1}']);
  });

  it("restitue plusieurs lignes presentes dans le meme chunk", () => {
    const decoder = new AcpFrameDecoder();
    const lines = decoder.push(utf8('{"a":1}\n{"a":2}\n{"a":3}\n'));
    expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
  });

  it("ne restitue rien tant que la ligne n'est pas terminee par un saut de ligne", () => {
    const decoder = new AcpFrameDecoder();
    const lines = decoder.push(utf8('{"a":1}'));
    expect(lines).toEqual([]);
  });

  it("recompose une ligne fragmentee sur plusieurs chunks", () => {
    const decoder = new AcpFrameDecoder();
    expect(decoder.push(utf8('{"a":'))).toEqual([]);
    expect(decoder.push(utf8("1"))).toEqual([]);
    expect(decoder.push(utf8("}\n"))).toEqual(['{"a":1}']);
  });

  it("conserve le reste apres une ligne complete pour le chunk suivant", () => {
    const decoder = new AcpFrameDecoder();
    expect(decoder.push(utf8('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(decoder.push(utf8("2}\n"))).toEqual(['{"b":2}']);
  });

  it("flush() retourne la ligne en attente non terminee (EOF sans \\n final)", () => {
    const decoder = new AcpFrameDecoder();
    decoder.push(utf8('{"a":1}'));
    expect(decoder.flush()).toBe('{"a":1}');
  });

  it("flush() retourne undefined si rien n'est en attente", () => {
    const decoder = new AcpFrameDecoder();
    expect(decoder.flush()).toBeUndefined();
  });

  it("decode correctement un caractere UTF-8 multi-octets fragmente entre deux chunks", () => {
    // "é" (e accent aigu) encode sur 2 octets en UTF-8 (0xC3 0xA9). On coupe
    // volontairement le chunk EN PLEIN MILIEU de ces 2 octets (apres 0xC3,
    // avant 0xA9) pour verifier que le decodeur ne decode qu'une fois la
    // ligne entiere reassemblee, jamais octet par octet en cours de route.
    const payload = utf8('{"label":"café"}\n');
    const decoder = new AcpFrameDecoder();
    const splitIndex = payload.length - 4; // juste apres le premier octet de "é"
    const firstHalf = payload.subarray(0, splitIndex);
    const secondHalf = payload.subarray(splitIndex);
    expect(decoder.push(firstHalf)).toEqual([]);
    expect(decoder.push(secondHalf)).toEqual(['{"label":"café"}']);
  });

  it("round-trip complet : encode -> decode -> parse retrouve le message d'origine", () => {
    const message = parseAcpMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: { protocolVersion: 1 },
      }),
    );
    const frame = encodeAcpFrame(serializeAcpMessage(message));
    const decoder = new AcpFrameDecoder();
    const [line] = decoder.push(utf8(frame));
    expect(parseAcpMessage(line)).toEqual(message);
  });
});
