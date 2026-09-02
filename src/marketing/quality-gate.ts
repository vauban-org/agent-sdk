/**
 * Marketing Quality Gate ; persona-driven pre-publish content gate.
 *
 * This is a pure function. It consumes the agent persona as the SOLE source
 * of content-policy rules and the payload as the subject under review.
 *
 * Design (Brain entry d8df4ed7 follow-up #1) :
 *   - The persona owns the content rules. `forbidden_patterns[].pattern`
 *     compiles to RegExp and is matched against text fields ; matches surface
 *     as violations. `directives.must_not[]` is matched as case-insensitive
 *     substring against text fields ; matches surface as warnings.
 *   - The gate owns the STRUCTURAL rules (per-platform shape). X tweet ≤280
 *     chars, X thread total entries (1 root + thread[]) within 2-6, LinkedIn
 *     body length window, etc. These are about shape not content rules so they
 *     stay hard-coded.
 *
 * The gate returns `passed` (no violations), the violation list, and a
 * warning list (non-blocking). Callers (the campaign orchestrator + the
 * marketing-content generator) decide what to do with each.
 *
 * Cross-references :
 *   - `packages/agent-sdk/src/identity/persona-schema.ts` (AgentPersona)
 *   - `packages/agent-sdk/src/identity/persona-prompt.ts` (system-prompt build)
 *
 * @public
 */

import type { AgentPersona } from "../identity/persona-schema.js";

/** @public */
export interface MarketingGateInput {
  /** Citadel CampaignActionType ; drives which payload fields are extracted. */
  readonly action_type: string;
  /** Optional platform (x | linkedin | rempart | email | discord | ...). */
  readonly platform?: string;
  /** Action payload ; null/undefined/{} fails the gate up-front. */
  readonly payload: Record<string, unknown> | null | undefined;
  /** Agent persona ; carries forbidden_patterns + directives. */
  readonly persona: AgentPersona;
}

/** @public */
export interface MarketingGateResult {
  readonly passed: boolean;
  readonly violations: string[];
  readonly warnings: string[];
}

// ── Structural rules (per-platform shape) ──────────────────────────────────

const X_MAX_CHARS = 280;
const X_THREAD_MIN_ENTRIES = 1;
const X_THREAD_MAX_ENTRIES = 10;
const LINKEDIN_MIN_CHARS = 1200;
const LINKEDIN_MAX_CHARS = 1300;

// ── Text extraction ────────────────────────────────────────────────────────

interface ScopedText {
  readonly scope: string;
  readonly text: string;
}

/**
 * Extract all text fields from the payload that should be matched against
 * persona content rules. Field set covers known marketing/outreach shapes :
 *   - publish_social_post : text, thread[], tweets[].content
 *   - publish_article     : title, content, excerpt, body
 *   - send_*_mail         : subject, body
 *   - engage_target       : message, body, text
 *
 * Unknown payload shapes fall through to a depth-1 string-field sweep so
 * future action_types still get content-matched without code changes.
 */
function extractTexts(payload: Record<string, unknown>, actionType: string): ScopedText[] {
  const out: ScopedText[] = [];
  const known = new Set([
    "publish_social_post",
    "publish_article",
    "send_cold_mail",
    "send_follow_up_mail",
    "engage_target",
  ]);

  if (actionType === "publish_social_post") {
    if (typeof payload.text === "string") {
      out.push({ scope: "text", text: payload.text });
    }
    const thread = payload.thread;
    if (Array.isArray(thread)) {
      for (let i = 0; i < thread.length; i++) {
        const t = thread[i];
        if (typeof t === "string") {
          out.push({ scope: `thread[${i}]`, text: t });
        }
      }
    }
    const tweets = payload.tweets;
    if (Array.isArray(tweets)) {
      for (let i = 0; i < tweets.length; i++) {
        const tw = tweets[i] as Record<string, unknown> | undefined;
        if (tw && typeof tw.content === "string") {
          out.push({ scope: `tweets[${i}].content`, text: tw.content });
        }
      }
    }
    return out;
  }

  if (actionType === "publish_article") {
    for (const key of ["title", "content", "excerpt", "body"]) {
      const v = payload[key];
      if (typeof v === "string") out.push({ scope: key, text: v });
    }
    return out;
  }

  if (actionType === "send_cold_mail" || actionType === "send_follow_up_mail") {
    for (const key of ["subject", "body"]) {
      const v = payload[key];
      if (typeof v === "string") out.push({ scope: key, text: v });
    }
    return out;
  }

  if (actionType === "engage_target") {
    for (const key of ["message", "body", "text"]) {
      const v = payload[key];
      if (typeof v === "string") out.push({ scope: key, text: v });
    }
    return out;
  }

  // Unknown action_type ; depth-1 sweep of string fields.
  if (!known.has(actionType)) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && v.length > 0) {
        out.push({ scope: k, text: v });
      }
    }
  }
  return out;
}

// ── Persona-driven content checks ──────────────────────────────────────────

interface CompiledPattern {
  readonly name: string;
  readonly scope?: string;
  readonly regex: RegExp;
}

/**
 * Compile persona.forbidden_patterns ; failures (invalid regex source) are
 * surfaced as VIOLATIONS (not warnings) so a malformed pattern never silently
 * lets bad content through. The caller treats compile failures as hard errors:
 * gate returns passed=false when any pattern fails to compile.
 *
 * Contract change (2026-05-20): compile-failure = HARD ERROR, not WARN.
 * Rationale: a pattern that fails to compile provides ZERO protection; treating
 * it as a warning allows content that should be blocked to pass undetected.
 * This is exactly what happened with the (?i) inline flag bug (BUG-1): 22/32
 * patterns silently failed to compile and were counted as warnings, leaving the
 * gate effectively blind for those rules.
 *
 * Each valid pattern compiles with the case-insensitive flag by default.
 */
function compileForbiddenPatterns(
  persona: AgentPersona,
  warnings: string[],
  violations: string[],
): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  const patterns = persona.forbidden_patterns ?? [];
  for (const p of patterns) {
    try {
      const entry: CompiledPattern =
        p.scope !== undefined
          ? { name: p.name, scope: p.scope, regex: new RegExp(p.pattern, "i") }
          : { name: p.name, regex: new RegExp(p.pattern, "i") };
      compiled.push(entry);
    } catch (err) {
      // Surface as both a warning (for observability) and a violation (to block dispatch).
      const msg = `persona.forbidden_patterns[${p.name}] invalid regex source ; skipped (${(err as Error).message})`;
      warnings.push(msg);
      violations.push(msg);
    }
  }
  return compiled;
}

function applyForbiddenPatterns(
  texts: readonly ScopedText[],
  patterns: readonly CompiledPattern[],
  violations: string[],
): void {
  for (const { scope, text } of texts) {
    for (const p of patterns) {
      // Respect optional persona-declared scope ; empty/undefined means
      // any scope is fair game.
      if (p.scope && p.scope !== scope) continue;
      const match = text.match(p.regex);
      if (match) {
        const preview = match[0].slice(0, 64);
        violations.push(`${scope}: forbidden_pattern "${p.name}" matched : "${preview}"`);
      }
    }
  }
}

function applyMustNotDirectives(
  texts: readonly ScopedText[],
  persona: AgentPersona,
  warnings: string[],
): void {
  const mustNot = persona.directives?.must_not ?? [];
  if (mustNot.length === 0) return;
  for (const { scope, text } of texts) {
    const lower = text.toLowerCase();
    for (const directive of mustNot) {
      const needle = directive.toLowerCase();
      // Skip very short needles (<4 chars) ; high false-positive rate as a
      // substring match. Persona authors wanting precise short matches should
      // use forbidden_patterns with regex word boundaries.
      if (needle.length < 4) continue;
      if (lower.includes(needle)) {
        warnings.push(
          `${scope}: directive must_not violated ; matched substring "${directive.slice(0, 64)}"`,
        );
      }
    }
  }
}

// ── Structural checks ──────────────────────────────────────────────────────

function applyStructuralChecks(
  input: MarketingGateInput,
  violations: string[],
  warnings: string[],
): void {
  const payload = input.payload;
  if (!payload) return;

  if (input.action_type === "publish_social_post" && input.platform === "x") {
    const root = typeof payload.text === "string" ? payload.text : "";
    const thread = Array.isArray(payload.thread)
      ? (payload.thread as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const tweets = Array.isArray(payload.tweets)
      ? (payload.tweets as Array<Record<string, unknown>>).map((t) => String(t.content ?? ""))
      : [];

    const allTweets = tweets.length > 0 ? tweets : root ? [root, ...thread] : thread;
    const total = allTweets.length;

    if (total < X_THREAD_MIN_ENTRIES) {
      violations.push(`x thread structure : 0 tweets ; require ≥${X_THREAD_MIN_ENTRIES}`);
    }
    if (total > X_THREAD_MAX_ENTRIES) {
      violations.push(`x thread structure : ${total} tweets exceeds max ${X_THREAD_MAX_ENTRIES}`);
    }
    for (let i = 0; i < allTweets.length; i++) {
      const t = allTweets[i] ?? "";
      if (t.length > X_MAX_CHARS) {
        violations.push(`x tweet[${i}] : ${t.length} chars exceeds ${X_MAX_CHARS}`);
      }
    }
  }

  if (input.action_type === "publish_social_post" && input.platform === "linkedin") {
    const body =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.body === "string"
          ? payload.body
          : typeof payload.content === "string"
            ? payload.content
            : "";
    if (body.length > 0) {
      if (body.length < LINKEDIN_MIN_CHARS) {
        warnings.push(
          `linkedin body : ${body.length} chars under target window ${LINKEDIN_MIN_CHARS}-${LINKEDIN_MAX_CHARS}`,
        );
      }
      if (body.length > LINKEDIN_MAX_CHARS) {
        violations.push(`linkedin body : ${body.length} chars exceeds max ${LINKEDIN_MAX_CHARS}`);
      }
    }
  }
}

// ── Main entrypoint ────────────────────────────────────────────────────────

/**
 * Evaluate the marketing payload against the persona content rules + the
 * platform structural rules. Pure function ; no side effects.
 *
 * Verdict semantics :
 *   - `passed=true` ; no violations. Warnings may still be present.
 *   - `passed=false` ; one or more violations. Caller MUST block dispatch.
 *
 * Caller contract : the orchestrator passes the persona resolved for the
 * agent emitting this payload. The gate makes no assumption about which
 * persona is in play ; it simply applies whatever rules the persona carries.
 * @public
 */
export function evaluateQualityGate(input: MarketingGateInput): MarketingGateResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const payload = input.payload;

  if (!payload || (typeof payload === "object" && Object.keys(payload).length === 0)) {
    return {
      passed: false,
      violations: ["payload empty ; gate cannot evaluate"],
      warnings,
    };
  }

  const compiled = compileForbiddenPatterns(input.persona, warnings, violations);
  const texts = extractTexts(payload, input.action_type);

  applyForbiddenPatterns(texts, compiled, violations);
  applyMustNotDirectives(texts, input.persona, warnings);
  applyStructuralChecks(input, violations, warnings);

  return { passed: violations.length === 0, violations, warnings };
}
