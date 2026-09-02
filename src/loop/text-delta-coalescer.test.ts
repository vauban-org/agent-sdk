/**
 * text-delta-coalescer.test.ts ; the C2 streaming coalescer (session-dans-la-poche,
 * docs/superpowers/specs/2026-07-23-session-dans-la-poche-design.md C2).
 *
 * A pure text-chunking primitive with an INJECTABLE clock (default Date.now) :
 * it turns pushed text into coalesced deltas, flushing when >= maxChars have
 * accumulated OR >= maxIntervalMs have elapsed since the last flush. The loop
 * feeds it a provider BLOCK today (no token stream), so only the size branch
 * fires in production ; the interval branch is the stream-ready contract and is
 * exercised here with a fake clock.
 */

import { describe, expect, it } from "vitest";
import { TextDeltaCoalescer } from "./text-delta-coalescer.js";

describe("TextDeltaCoalescer ; size-driven flush (the live branch today)", () => {
  it("emits a single delta for a block at or under maxChars", () => {
    const out: string[] = [];
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s), maxChars: 1200 });
    c.push("a short answer");
    c.flush();
    expect(out).toEqual(["a short answer"]);
  });

  it("chunks a block larger than maxChars into maxChars-sized deltas plus a remainder", () => {
    const out: string[] = [];
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s), maxChars: 10 });
    c.push("a".repeat(25));
    // 25 chars, maxChars 10 -> two full 10-char size flushes during push...
    expect(out).toEqual(["aaaaaaaaaa", "aaaaaaaaaa"]);
    c.flush(); // ...then the 5-char remainder on explicit flush.
    expect(out).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
  });

  it("the concatenation of every delta reproduces the original block byte-for-byte", () => {
    const out: string[] = [];
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s), maxChars: 7 });
    const original = "The quick brown fox jumps over the lazy dog";
    c.push(original);
    c.flush();
    expect(out.join("")).toBe(original);
  });

  it("never splits a surrogate pair across a chunk boundary (emoji integrity)", () => {
    const out: string[] = [];
    // maxChars 3 forces a cut where a naive slice would split the 😀 pair.
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s), maxChars: 3 });
    const original = "ab😀cd😀ef";
    c.push(original);
    c.flush();
    // Concatenation is lossless...
    expect(out.join("")).toBe(original);
    // ...and no delta ends on a lone high surrogate (0xD800-0xDBFF).
    for (const d of out) {
      const last = d.charCodeAt(d.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("never emits an empty delta", () => {
    const out: string[] = [];
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s), maxChars: 5 });
    c.push("");
    c.flush();
    c.push("");
    expect(out).toEqual([]);
  });

  it("flush on an empty buffer is a no-op", () => {
    const out: string[] = [];
    const c = new TextDeltaCoalescer({ onFlush: (s) => out.push(s) });
    c.flush();
    c.flush();
    expect(out).toEqual([]);
  });
});

describe("TextDeltaCoalescer ; interval-driven flush (the stream-ready branch)", () => {
  it("coalesces small pushes and flushes them together once maxIntervalMs elapses", () => {
    const out: string[] = [];
    let t = 0;
    const c = new TextDeltaCoalescer({
      onFlush: (s) => out.push(s),
      maxChars: 1200,
      maxIntervalMs: 350,
      now: () => t,
    });
    c.push("hel"); // t=0, elapsed 0 < 350 -> buffered, no flush
    c.push("lo"); // still t=0 -> buffered
    expect(out).toEqual([]);
    t = 400; // clock advances past the interval
    c.push(" world"); // elapsed 400 >= 350 -> flush the whole accumulated buffer
    expect(out).toEqual(["hello world"]);
  });

  it("does not flush before the interval elapses (pure coalescing)", () => {
    const out: string[] = [];
    let t = 0;
    const c = new TextDeltaCoalescer({
      onFlush: (s) => out.push(s),
      maxChars: 1200,
      maxIntervalMs: 350,
      now: () => t,
    });
    c.push("a");
    t = 100;
    c.push("b");
    t = 300;
    c.push("c");
    expect(out).toEqual([]); // 300 < 350, nothing flushed yet
    c.flush(); // explicit flush drains the remainder
    expect(out).toEqual(["abc"]);
  });

  it("the size branch preempts the interval branch (a big push flushes immediately)", () => {
    const out: string[] = [];
    const t = 0;
    const c = new TextDeltaCoalescer({
      onFlush: (s) => out.push(s),
      maxChars: 5,
      maxIntervalMs: 10_000,
      now: () => t,
    });
    c.push("abcdefg"); // 7 chars, maxChars 5 -> size flush "abcde" now, buffer "fg"
    expect(out).toEqual(["abcde"]);
    c.flush();
    expect(out).toEqual(["abcde", "fg"]);
  });
});
