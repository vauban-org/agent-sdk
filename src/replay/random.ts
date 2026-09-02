/**
 * RandomPort — dual-API random number source for deterministic replay.
 *
 * CH4 DUAL API DESIGN:
 *   Two distinct APIs with different guarantees — never conflate them:
 *
 *   Deterministic (replay-safe, NON SECURITY-GRADE):
 *     next()   — float in [0, 1) via xorshift32 seeded PRNG
 *     uuid()   — deterministic v4-like UUID from xorshift32 (NOT crypto-strong)
 *
 *   Crypto-strong (NON REPLAY-SAFE by design — security trumps audit):
 *     crypto(bytes)  — random bytes via globalThis.crypto.getRandomValues
 *     cryptoUuid()   — crypto-strong UUID via globalThis.crypto.randomUUID
 *
 * Use next()/uuid() for application logic that needs to be replayable.
 * Use crypto()/cryptoUuid() for security-critical values (tokens, nonces, keys)
 * that MUST NOT be replayable.
 *
 * During replay, calling crypto()/cryptoUuid() on RecordedRandom in strict mode
 * throws CryptoRandomDuringReplayError to surface the violation at the boundary.
 *
 * @module replay/random
 */

// ─── RandomPort interface ─────────────────────────────────────────────────────

/**
 * Abstract random source with a dual API:
 * - Deterministic arm (next/uuid): seedable, replay-safe, NON SECURITY-GRADE.
 * - Crypto arm (crypto/cryptoUuid): crypto-strong, NON REPLAY-SAFE by design.
 * @public
 */
export interface RandomPort {
  /**
   * Returns a float in [0, 1) via the deterministic PRNG.
   * NON SECURITY-GRADE — use for application logic only.
   */
  next(): number;

  /**
   * Returns a deterministic v4-like UUID from the seeded PRNG.
   * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
   * NON SECURITY-GRADE — use for replayable correlation IDs only.
   */
  uuid(): string;

  /**
   * Returns `bytes` cryptographically random bytes via globalThis.crypto.
   * NON REPLAY-SAFE by design — security trumps audit.
   */
  crypto(bytes: number): Promise<Uint8Array>;

  /**
   * Returns a cryptographically strong UUID via globalThis.crypto.randomUUID.
   * NON REPLAY-SAFE by design.
   */
  cryptoUuid(): string;
}

// ─── CryptoRandomDuringReplayError ────────────────────────────────────────────

/**
 * Thrown by RecordedRandom in 'strict' mode when crypto()/cryptoUuid() is called.
 * Signals that the agent called a non-replayable code path during replay —
 * a violation of the deterministic replay contract.
 * @public
 */
export class CryptoRandomDuringReplayError extends Error {
  constructor() {
    super(
      "crypto() / cryptoUuid() called during replay. " +
        "Crypto random is NON-REPLAY-SAFE by design (security trumps audit). " +
        "Use random.next() / random.uuid() for replayable values.",
    );
    this.name = "CryptoRandomDuringReplayError";
  }
}

// ─── xorshift32 PRNG ─────────────────────────────────────────────────────────

/**
 * xorshift32 — minimal seedable PRNG.
 * Period: 2^32 - 1. Passes BigCrush for basic applications.
 * NOT cryptographically secure — use only for deterministic application logic.
 *
 * Reference: Marsaglia, G. (2003). "Xorshift RNGs". Journal of Statistical Software.
 */
function xorshift32(state: Uint32Array): number {
  let x = state[0];
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state[0] = x >>> 0; // force unsigned 32-bit
  return x >>> 0;
}

/** Convert 4 uint32 nibbles to a standard UUID v4-like hex string. */
function nibblesToUuid(a: number, b: number, c: number, d: number): string {
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");

  // v4-like: set version bits (4) and variant bits (10xx)
  const timeLow = hex(a, 8);
  const timeMid = hex((b >>> 16) & 0xffff, 4);
  // version nibble: force 4
  const timeHiAndVersion = hex((b & 0x0fff) | 0x4000, 4);
  // variant: force 10xx
  const clockSeqHiAndRes = hex(((c >>> 24) & 0x3f) | 0x80, 2);
  const clockSeqLow = hex((c >>> 16) & 0xff, 2);
  const node = hex(((c & 0xffff) * 0x100000000 + d) >>> 0, 12).padStart(12, "0");

  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeqHiAndRes}${clockSeqLow}-${node}`;
}

// ─── RealRandom ───────────────────────────────────────────────────────────────

/**
 * Production implementation:
 * - next()/uuid(): xorshift32 seeded PRNG (deterministic if seed is fixed).
 * - crypto()/cryptoUuid(): globalThis.crypto (non-deterministic, crypto-strong).
 *
 * Pass a fixed seed to make next()/uuid() deterministic across runs.
 * Default seed: Date.now() XOR a random 32-bit value (non-deterministic).
 * @public
 */
export class RealRandom implements RandomPort {
  private readonly state: Uint32Array;

  constructor(seed?: number) {
    const s =
      seed !== undefined
        ? seed >>> 0 // coerce to uint32
        : (Date.now() ^ Math.floor(Math.random() * 2 ** 32)) >>> 0;
    // xorshift32 must not start with 0
    this.state = new Uint32Array([s === 0 ? 1 : s]);
  }

  next(): number {
    // xorshift32 returns uint32; divide by 2^32 to get [0, 1)
    return xorshift32(this.state) / 0x100000000;
  }

  uuid(): string {
    const a = xorshift32(this.state);
    const b = xorshift32(this.state);
    const c = xorshift32(this.state);
    const d = xorshift32(this.state);
    return nibblesToUuid(a, b, c, d);
  }

  async crypto(bytes: number): Promise<Uint8Array> {
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }

  cryptoUuid(): string {
    return globalThis.crypto.randomUUID();
  }
}

// ─── RecordedRandom ───────────────────────────────────────────────────────────

/**
 * Replay implementation: replays recorded next()/uuid() sequences.
 *
 * - next(): returns the next value from recordedNext (throws RangeError when exhausted).
 * - uuid(): returns the next value from recordedUuids (throws RangeError when exhausted).
 * - crypto(): throws CryptoRandomDuringReplayError in 'strict' mode;
 *             returns fresh crypto bytes in 'tolerant' mode.
 * - cryptoUuid(): throws CryptoRandomDuringReplayError in 'strict' mode;
 *                 returns fresh crypto UUID in 'tolerant' mode.
 * @public
 */
export class RecordedRandom implements RandomPort {
  private nextCursor = 0;
  private uuidCursor = 0;

  constructor(
    private readonly recordedNext: readonly number[],
    private readonly recordedUuids: readonly string[],
    private readonly mode: "strict" | "tolerant" = "strict",
  ) {}

  next(): number {
    if (this.nextCursor >= this.recordedNext.length) {
      throw new RangeError(
        `RecordedRandom.next() exhausted: ${this.recordedNext.length} values recorded, ` +
          `${this.nextCursor + 1} requested`,
      );
    }
    return this.recordedNext[this.nextCursor++];
  }

  uuid(): string {
    if (this.uuidCursor >= this.recordedUuids.length) {
      throw new RangeError(
        `RecordedRandom.uuid() exhausted: ${this.recordedUuids.length} values recorded, ` +
          `${this.uuidCursor + 1} requested`,
      );
    }
    return this.recordedUuids[this.uuidCursor++];
  }

  async crypto(bytes: number): Promise<Uint8Array> {
    if (this.mode === "strict") {
      throw new CryptoRandomDuringReplayError();
    }
    // tolerant: return fresh crypto bytes (non-deterministic but not fatal)
    const buf = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }

  cryptoUuid(): string {
    if (this.mode === "strict") {
      throw new CryptoRandomDuringReplayError();
    }
    return globalThis.crypto.randomUUID();
  }

  /**
   * Returns a new RecordedRandom that shares the same underlying recorded arrays
   * and starts at the CURRENT cursor positions (nextCursor + uuidCursor). Each
   * clone maintains its own independent cursors — arrays are shared (read-only).
   *
   * Use for cross-cycle propagation: child cycle picks up exactly where the
   * parent left off in both the next() and uuid() sequences.
   *
   * Clone invariant: clone.next() returns the same value as `this.next()` would
   * at the moment clone() is called.
   */
  clone(): RecordedRandom {
    const child = new RecordedRandom(this.recordedNext, this.recordedUuids, this.mode);
    child.nextCursor = this.nextCursor;
    child.uuidCursor = this.uuidCursor;
    return child;
  }

  /** Returns current nextCursor (number of next() values consumed). */
  getNextCursor(): number {
    return this.nextCursor;
  }

  /** Returns current uuidCursor (number of uuid() values consumed). */
  getUuidCursor(): number {
    return this.uuidCursor;
  }
}
