/**
 * Tests for packages/agent-sdk/src/hitl/api.ts
 *
 * Coverage:
 *   parseCallbackData — compact format {a, v}, legacy format {approval_id, action},
 *                       compact priority over legacy, all null paths
 *   extractHeaders — single-value, multi-value (joined), undefined/null skipped,
 *                    empty, multiple headers, key casing preserved
 *   collectBody — stream concatenation, empty body, stream error
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { collectBody, extractHeaders, parseCallbackData } from "../src/hitl/api.js";
import type { HITLCallbackData } from "../src/hitl/api.js";

// ─── parseCallbackData ────────────────────────────────────────────────────────

describe("parseCallbackData", () => {
  // Compact format { a, v }
  it("parses compact approve", () => {
    const result = parseCallbackData('{"a":"id-123","v":"approve"}');
    expect(result).toEqual<HITLCallbackData>({
      approvalId: "id-123",
      action: "approve",
    });
  });

  it("parses compact reject", () => {
    const result = parseCallbackData('{"a":"id-456","v":"reject"}');
    expect(result).toEqual<HITLCallbackData>({
      approvalId: "id-456",
      action: "reject",
    });
  });

  it("parses compact format with extra fields (extra fields ignored)", () => {
    const result = parseCallbackData('{"a":"extra-id","v":"approve","extra":"ignored","num":42}');
    expect(result).toEqual<HITLCallbackData>({
      approvalId: "extra-id",
      action: "approve",
    });
  });

  // Legacy format { approval_id, action }
  it("parses legacy approve", () => {
    const result = parseCallbackData('{"approval_id":"old-id","action":"approve"}');
    expect(result).toEqual<HITLCallbackData>({
      approvalId: "old-id",
      action: "approve",
    });
  });

  it("parses legacy reject", () => {
    const result = parseCallbackData('{"approval_id":"x","action":"reject"}');
    expect(result).toEqual<HITLCallbackData>({
      approvalId: "x",
      action: "reject",
    });
  });

  // Priority: compact wins over legacy
  it("uses compact a when both a and approval_id are present", () => {
    const result = parseCallbackData(
      '{"a":"compact-id","approval_id":"legacy-id","v":"approve","action":"approve"}',
    );
    expect(result).not.toBeNull();
    expect(result!.approvalId).toBe("compact-id");
  });

  it("compact v wins over legacy action when both are present", () => {
    const result = parseCallbackData('{"a":"req-1","v":"approve","action":"reject"}');
    expect(result?.action).toBe("approve");
  });

  // Null cases
  it("returns null for invalid JSON", () => {
    expect(parseCallbackData("{not:json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCallbackData("")).toBeNull();
  });

  it("returns null for empty object {}", () => {
    expect(parseCallbackData("{}")).toBeNull();
  });

  it("returns null for invalid action value", () => {
    expect(parseCallbackData('{"a":"id","v":"invalid-action"}')).toBeNull();
  });

  it("returns null for empty approvalId string", () => {
    expect(parseCallbackData('{"a":"","v":"approve"}')).toBeNull();
  });

  it("throws when JSON null literal is parsed (source does not guard against null object)", () => {
    // JSON.parse("null") returns null; source casts to Record<string, unknown>
    // and immediately accesses null["a"], which throws TypeError (not caught by source).
    expect(() => parseCallbackData("null")).toThrow(TypeError);
  });

  it("returns null when a and approval_id are both absent", () => {
    expect(parseCallbackData('{"v":"approve"}')).toBeNull();
  });

  it("returns null when action/v is absent", () => {
    expect(parseCallbackData('{"a":"id"}')).toBeNull();
  });

  it("returns null for array JSON", () => {
    expect(parseCallbackData('["a","approve"]')).toBeNull();
  });

  it("returns null for numeric JSON", () => {
    expect(parseCallbackData("42")).toBeNull();
  });

  it("returns null for legacy format with invalid action", () => {
    expect(parseCallbackData('{"approval_id":"x","action":"maybe"}')).toBeNull();
  });
});

// ─── extractHeaders ───────────────────────────────────────────────────────────

describe("extractHeaders", () => {
  function fakeReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it("preserves single-value header as-is", () => {
    const result = extractHeaders(fakeReq({ "content-type": "application/json" }));
    expect(result["content-type"]).toBe("application/json");
  });

  it("joins multi-value header array with ', '", () => {
    const result = extractHeaders(fakeReq({ accept: ["text/html", "application/json"] }));
    expect(result.accept).toBe("text/html, application/json");
  });

  it("skips undefined header value", () => {
    const result = extractHeaders(fakeReq({ "x-forwarded-for": undefined }));
    expect("x-forwarded-for" in result).toBe(false);
  });

  it("returns empty object for empty headers", () => {
    expect(extractHeaders(fakeReq({}))).toEqual({});
  });

  it("preserves multiple headers", () => {
    const result = extractHeaders(
      fakeReq({
        "content-type": "application/json",
        authorization: "Bearer token123",
        "x-request-id": "req-abc",
      }),
    );
    expect(result).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token123",
      "x-request-id": "req-abc",
    });
  });

  it("preserves header key casing as-is", () => {
    const result = extractHeaders(fakeReq({ "X-Custom-Header": "value" }));
    expect("X-Custom-Header" in result).toBe(true);
    expect(result["X-Custom-Header"]).toBe("value");
  });

  it("skips null value", () => {
    const result = extractHeaders(fakeReq({ "x-null-header": null as never }));
    expect("x-null-header" in result).toBe(false);
  });

  it("joins three-element header array with ', '", () => {
    const result = extractHeaders(fakeReq({ "set-cookie": ["a=1", "b=2", "c=3"] }));
    expect(result["set-cookie"]).toBe("a=1, b=2, c=3");
  });

  it("handles mix of single-value, multi-value, and undefined headers", () => {
    const result = extractHeaders(
      fakeReq({
        host: "example.com",
        "accept-encoding": ["gzip", "deflate"],
        connection: undefined,
      }),
    );
    expect(result.host).toBe("example.com");
    expect(result["accept-encoding"]).toBe("gzip, deflate");
    expect("connection" in result).toBe(false);
  });
});

// ─── collectBody ─────────────────────────────────────────────────────────────

describe("collectBody", () => {
  it("concatenates streamed chunks into a UTF-8 string", async () => {
    const emitter = new EventEmitter();
    const bodyPromise = collectBody(emitter as unknown as IncomingMessage);
    emitter.emit("data", Buffer.from("hello"));
    emitter.emit("data", Buffer.from(" world"));
    emitter.emit("end");
    expect(await bodyPromise).toBe("hello world");
  });

  it("resolves empty string when no data chunks emitted", async () => {
    const emitter = new EventEmitter();
    const bodyPromise = collectBody(emitter as unknown as IncomingMessage);
    emitter.emit("end");
    expect(await bodyPromise).toBe("");
  });

  it("rejects on stream error", async () => {
    const emitter = new EventEmitter();
    const bodyPromise = collectBody(emitter as unknown as IncomingMessage);
    emitter.emit("error", new Error("stream broken"));
    await expect(bodyPromise).rejects.toThrow("stream broken");
  });
});
