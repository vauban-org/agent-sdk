/**
 * VCR HTTP cassettes — record/replay for replay-safe HTTP tools.
 *
 * Sprint-563: B9 — Node.js native HTTP recording (no nock dependency).
 * Cassettes stored by hash(URL + method + body), served on strict replay.
 *
 * Mode 'record': store the real HTTP response for later replay.
 * Mode 'replay': serve cassettes; throw on miss in strict mode.
 */

import { createHash } from "node:crypto";

/** @public */
export type VCRMode = "record" | "replay";

/** @public */
export interface VCRCassette {
  url: string;
  method: string;
  requestBody: string | null;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

/** @public */
export interface VCRStats {
  hits: number;
  misses: number;
  recorded: number;
}

/** @public */
export class UndeterministicSideEffectError extends Error {
  constructor(url: string, method: string) {
    super(
      `Replay mode (strict): HTTP ${method} ${url} has no cassette. Record first or use tolerant mode.`,
    );
    this.name = "UndeterministicSideEffectError";
  }
}

/**
 * In-memory HTTP VCR for deterministic replay of HTTP side effects.
 * @public
 */
export class HttpVCR {
  private cassettes = new Map<string, VCRCassette>();
  mode: VCRMode = "record";
  stats: VCRStats = { hits: 0, misses: 0, recorded: 0 };

  static key(url: string, method: string, body: string | null): string {
    const hash = createHash("sha256");
    hash.update(`${method}:${url}`);
    if (body) hash.update(`:${body}`);
    return hash.digest("hex");
  }

  /** Record or replay an HTTP call. In record mode, captures the real response. */
  async intercept(
    url: string,
    method: string,
    body: string | null,
    realFetch: () => Promise<Response>,
  ): Promise<Response> {
    const key = HttpVCR.key(url, method, body);

    if (this.mode === "replay") {
      const cassette = this.cassettes.get(key);
      if (cassette) {
        this.stats.hits++;
        return new Response(cassette.body, {
          status: cassette.status,
          statusText: cassette.statusText,
          headers: cassette.headers,
        });
      }
      this.stats.misses++;
      throw new UndeterministicSideEffectError(url, method);
    }

    // Record mode
    const response = await realFetch();
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    this.cassettes.set(key, {
      url,
      method,
      requestBody: body,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      timestamp: Date.now(),
    });
    this.stats.recorded++;

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  /** Load cassettes from a previous recording (for replay mode). */
  load(cassettes: VCRCassette[]): void {
    for (const c of cassettes) {
      this.cassettes.set(HttpVCR.key(c.url, c.method, c.requestBody), c);
    }
  }

  /** Export all cassettes for storage. */
  export(): VCRCassette[] {
    return [...this.cassettes.values()];
  }

  /** Clear all cassettes. */
  clear(): void {
    this.cassettes.clear();
    this.stats = { hits: 0, misses: 0, recorded: 0 };
  }
}
