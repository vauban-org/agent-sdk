/**
 * remote/sub-token-otel — OpenTelemetry instrumentation for sub-tokens (P11).
 *
 * Sub-token mint / verify / revoke are security-critical actions. Without
 * observability, operators flying blind can't detect : a sudden burst of
 * mints, a spike in verify-failures (signature brute-force), revocation
 * floods, or a clock-skew issue that exp-rejects every token.
 *
 * This module wraps the pure functions in `sub-token.ts` with OTEL spans
 * + counters. The pure module stays free of OTEL imports (preserves the
 * "library code is environment-agnostic" property) ; consumers opt in
 * by importing from this file instead.
 *
 * Why a separate file
 * -------------------
 *   - `sub-token.ts` is a stable surface used by tests + CLI + browser
 *     PWA. Avoiding the @opentelemetry/api import keeps that surface
 *     tree-shakeable + bundleable for the web.
 *   - This file is opt-in : the http-server adapter + CLI publish surface
 *     point at it, but a thin SDK consumer can keep using `sub-token.ts`
 *     directly with zero OTEL overhead.
 *
 * Span shape
 * ----------
 *   subtoken.mint
 *     attributes: subtoken.scope, subtoken.ttl_sec, subtoken.success
 *   subtoken.verify
 *     attributes: subtoken.result (valid | malformed | expired | sig_mismatch
 *                | revoked | unknown_scope | wrong_version), subtoken.scope
 *   subtoken.revoke
 *     attributes: subtoken.jti.hash (sha256 truncated, 8 chars — never the
 *                raw jti so logs aren't tokens themselves)
 *     subtoken.was_revoked (idempotency signal)
 *
 * Metric shape
 * ------------
 *   counter subtoken.mints_total{scope}                 — every mint
 *   counter subtoken.verifies_total{result,scope?}      — every verify call
 *   counter subtoken.revocations_total{idempotent}      — every revoke call
 *
 * No-op cost
 * ----------
 * `@opentelemetry/api` returns a no-op tracer + meter when no SDK is
 * registered. The overhead is ~50ns per call ; the security wins are
 * worth it even in pure-loopback dev.
 *
 * @public @since 2.22.0 — preste P11 (sub-token observability)
 */

import { createHash } from "node:crypto";
import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import {
  type MintSubTokenOptions,
  type SubTokenScope,
  type VerifySubTokenResult,
  mintSubToken,
  resolveAuthScope,
  verifySubToken,
} from "./sub-token.js";

const TRACER = trace.getTracer("vauban-agent-sdk.remote.sub-token", "1.0.0");
const METER = metrics.getMeter("vauban-agent-sdk.remote.sub-token", "1.0.0");

const mintCounter = METER.createCounter("subtoken.mints_total", {
  description: "Total sub-tokens minted, by scope.",
});
const verifyCounter = METER.createCounter("subtoken.verifies_total", {
  description: "Total verify calls, by result.",
});
const revokeCounter = METER.createCounter("subtoken.revocations_total", {
  description: "Total revoke calls, by idempotency.",
});

/**
 * Truncated SHA-256 of a jti for safe logging.
 * @public
 */
export function hashJti(jti: string): string {
  return createHash("sha256").update(jti).digest("hex").slice(0, 8);
}

/**
 * Instrumented variant of `mintSubToken`. Emits a span and increments
 * the `subtoken.mints_total` counter. Forwards all option semantics.
 * @public
 */
export function mintSubTokenInstrumented(opts: MintSubTokenOptions): string {
  const span = TRACER.startSpan("subtoken.mint");
  span.setAttribute("subtoken.scope", opts.scope);
  span.setAttribute("subtoken.ttl_sec", opts.ttlSec);
  try {
    const token = mintSubToken(opts);
    span.setAttribute("subtoken.success", true);
    mintCounter.add(1, { scope: opts.scope });
    span.end();
    return token;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("subtoken.success", false);
    span.end();
    throw err;
  }
}

/**
 * Instrumented variant of `verifySubToken`. Always ends in a span ; the
 * failure shape (`{valid:false,reason}`) is preserved verbatim so the
 * caller's branching is unchanged.
 * @public
 */
export function verifySubTokenInstrumented(
  parentToken: string,
  token: string,
  now: number = Date.now(),
): VerifySubTokenResult {
  const span = TRACER.startSpan("subtoken.verify");
  const result = verifySubToken(parentToken, token, now);
  const outcome = result.valid ? "valid" : classifyReason(result.reason ?? "");
  span.setAttribute("subtoken.result", outcome);
  if (result.scope) span.setAttribute("subtoken.scope", result.scope);
  verifyCounter.add(1, {
    result: outcome,
    ...(result.scope ? { scope: result.scope } : {}),
  });
  if (!result.valid) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.reason });
  }
  span.end();
  return result;
}

/**
 * Instrumented variant of `resolveAuthScope`. Wraps a single verify span
 * and a `subtoken.parent_match` attribute when the presented token is the
 * parent itself (skipping the sub-token verify path).
 * @public
 */
export function resolveAuthScopeInstrumented(
  parentToken: string,
  presentedToken: string,
  now: number = Date.now(),
  isRevoked?: (jti: string) => boolean,
): SubTokenScope | undefined {
  const span = TRACER.startSpan("subtoken.resolve_auth_scope");
  // Detect parent-token match cheaply for the attribute (the resolve
  // function does its own constant-time check internally).
  const isParent = presentedToken === parentToken;
  span.setAttribute("subtoken.parent_match", isParent);
  const scope = resolveAuthScope(parentToken, presentedToken, now, isRevoked);
  if (scope) span.setAttribute("subtoken.granted_scope", scope);
  else span.setAttribute("subtoken.granted_scope", "none");
  span.end();
  return scope;
}

/**
 * Record a revocation event. Pure metrics helper — the actual deny-list
 * mutation lives in the http-server / persistence layer. Pass `alreadyRevoked`
 * so the idempotency-vs-new dimension stays observable.
 * @public
 */
export function recordRevocation(jti: string, alreadyRevoked: boolean): void {
  const span = TRACER.startSpan("subtoken.revoke");
  span.setAttribute("subtoken.jti.hash", hashJti(jti));
  span.setAttribute("subtoken.was_revoked", alreadyRevoked);
  revokeCounter.add(1, { idempotent: String(alreadyRevoked) });
  span.end();
}

/**
 * Map a `verifySubToken` reason string to a coarse-grained outcome label
 * (kept stable for dashboards). Exported for tests.
 * @public
 */
export function classifyReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("malformed")) return "malformed";
  if (r.includes("expired")) return "expired";
  if (r.includes("signature")) return "sig_mismatch";
  if (r.includes("revoked")) return "revoked";
  if (r.includes("scope")) return "unknown_scope";
  if (r.includes("version")) return "wrong_version";
  if (r.includes("payload")) return "bad_payload";
  if (r.includes("exp ")) return "bad_exp";
  return "unknown_error";
}
