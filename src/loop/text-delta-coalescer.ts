/**
 * text-delta-coalescer ; the C2 streaming primitive (session-dans-la-poche,
 * docs/superpowers/specs/2026-07-23-session-dans-la-poche-design.md C2).
 *
 * Turns pushed assistant text into COALESCED deltas : a flush happens when the
 * accumulated buffer reaches `maxChars`, OR when `maxIntervalMs` has elapsed
 * since the last flush. Both bounds keep the relay budget tame (~2-3 events/s
 * during generation) while a viewer still sees the text appear.
 *
 * Provider reality (why the interval branch is dormant in production today) :
 * `ProviderRouter.complete()` returns each step as a BLOCK, not a token stream
 * (see `router/provider-router.ts`). The loop therefore pushes the whole block
 * at once and calls `flush()`, so only the size branch fires : a block <=
 * maxChars becomes one delta, a larger block is chunked at maxChars. This is
 * the honest granularity ; NO artificial per-character timer fakes a stream.
 * When a real token stream is wired, the SAME coalescer coalesces tokens and
 * the interval branch activates ; the loop wiring does not change.
 *
 * The clock is injected (`now`, default `Date.now`) so the interval branch is
 * deterministically testable without wall-clock sleeps ; the loop has no clock
 * port of its own, so the coalescer owns this small seam.
 *
 * Pure : it holds only a string buffer and a last-flush timestamp, and calls
 * `onFlush` for each coalesced delta. It never imports the event or sink layer
 * ; the loop wires `onFlush` to `sink.emit(makeEphemeralDelta(chunk))`.
 */

/** Construction options for {@link TextDeltaCoalescer}. */
export interface TextDeltaCoalescerOptions {
  /** Emit one coalesced delta. Called once per flush, never with an empty string. */
  onFlush: (text: string) => void;
  /** Flush when the buffer reaches this many chars. Default 1200. */
  maxChars?: number;
  /** Flush when this many ms elapsed since the last flush. Default 350. */
  maxIntervalMs?: number;
  /** Injected clock (ms). Default `Date.now`. */
  now?: () => number;
}

/** True iff `code` is a UTF-16 high surrogate (the lead half of a pair). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export class TextDeltaCoalescer {
  private readonly onFlush: (text: string) => void;
  private readonly maxChars: number;
  private readonly maxIntervalMs: number;
  private readonly now: () => number;

  private buffer = "";
  private lastFlushAt: number;

  constructor(opts: TextDeltaCoalescerOptions) {
    this.onFlush = opts.onFlush;
    this.maxChars = opts.maxChars ?? 1200;
    this.maxIntervalMs = opts.maxIntervalMs ?? 350;
    this.now = opts.now ?? Date.now;
    this.lastFlushAt = this.now();
  }

  /**
   * Append text. May emit zero or more deltas : one per full `maxChars` chunk
   * that accumulates (size branch), then one more if `maxIntervalMs` has
   * elapsed since the last flush and text remains (interval branch).
   */
  push(text: string): void {
    if (text.length === 0) return;
    this.buffer += text;

    // Size branch : drain full maxChars-sized chunks, never splitting a
    // surrogate pair at the boundary.
    while (this.buffer.length >= this.maxChars) {
      const cut = this.safeCut(this.maxChars);
      // safeCut can only fall below maxChars by backing off one unit off a
      // split pair ; the buffer is >= maxChars so cut is always >= 1.
      this.emit(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
    }

    // Interval branch : the stream-ready path (dormant while the provider
    // returns whole blocks ; see the module header).
    if (this.buffer.length > 0 && this.now() - this.lastFlushAt >= this.maxIntervalMs) {
      this.emit(this.buffer);
      this.buffer = "";
    }
  }

  /** Force-emit any buffered text as a final delta. Idempotent when empty. */
  flush(): void {
    if (this.buffer.length === 0) return;
    this.emit(this.buffer);
    this.buffer = "";
  }

  private emit(chunk: string): void {
    if (chunk.length === 0) return;
    this.lastFlushAt = this.now();
    this.onFlush(chunk);
  }

  /**
   * The largest cut index <= `max` that does not leave a lone high surrogate at
   * the end of the chunk (which would split an astral code point across two
   * deltas). Backs off by one UTF-16 unit when the boundary lands mid-pair ; the
   * low half then leads the next chunk, so concatenation stays lossless.
   */
  private safeCut(max: number): number {
    const k = Math.min(max, this.buffer.length);
    if (k < this.buffer.length && isHighSurrogate(this.buffer.charCodeAt(k - 1))) {
      return k - 1;
    }
    return k;
  }
}
