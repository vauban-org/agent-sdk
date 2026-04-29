/**
 * http_fetch — GET only, allow-listed domains via env HTTP_FETCH_ALLOWLIST
 * (comma-sep list of bare hostnames or `*.example.com` patterns).
 *
 * @public
 */
import { z } from "zod";
import type { Skill, SkillContext } from "../orchestration/ooda/skills.js";
import { HttpFetchAllowlistError, SkillExecutionError } from "./errors.js";
import { withSkillSpan } from "./_otel.js";

const inputSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().int().min(100).max(30_000).default(15_000),
  })
  .strict();
type HttpFetchInput = z.infer<typeof inputSchema>;

export interface HttpFetchOutput {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

const MAX_RESPONSE_BYTES = 512 * 1024;

function parseAllowlist(): string[] {
  const raw = process.env.HTTP_FETCH_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  const lower = host.toLowerCase();
  return allowlist.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return lower.endsWith(suffix) && lower !== suffix.slice(1);
    }
    return lower === pattern;
  });
}

export const httpFetch: Skill<HttpFetchInput, HttpFetchOutput> = {
  name: "http_fetch",
  inputSchema,
  async execute(input, ctx: SkillContext): Promise<HttpFetchOutput> {
    const parsed = new URL(input.url);
    const allowlist = parseAllowlist();
    if (allowlist.length === 0) {
      throw new HttpFetchAllowlistError(input.url, parsed.hostname);
    }
    if (!isHostAllowed(parsed.hostname, allowlist)) {
      throw new HttpFetchAllowlistError(input.url, parsed.hostname);
    }
    if (ctx.isReplay) {
      const mock = ctx.dryRunMocks["http_fetch"];
      if (mock) return mock(input) as HttpFetchOutput;
      return { status: 0, headers: {}, body: "", truncated: false };
    }
    return withSkillSpan("http_fetch", async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), input.timeout_ms);
      try {
        const res = await fetch(input.url, {
          method: "GET",
          headers: input.headers,
          signal: ac.signal,
        });
        const text = await res.text();
        const truncated = text.length > MAX_RESPONSE_BYTES;
        const body = truncated ? text.slice(0, MAX_RESPONSE_BYTES) : text;
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body, truncated };
      } catch (err) {
        throw new SkillExecutionError("http_fetch", "fetch error", {
          cause: err,
        });
      } finally {
        clearTimeout(timer);
      }
    });
  },
};
