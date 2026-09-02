/**
 * delivery/anchor-checks.ts
 *
 * The registry of deterministic anchor implementations, keyed by AnchorId, plus
 * the classification sets that tell `buildAnchorLens` which anchors cannot be
 * answered from the artifact bytes alone.
 *
 * Three anchor families live here by classification:
 *   - PURE                       ; a function of the artifact bytes. The ungameable
 *                                  floor. Implemented in {@link ANCHOR_CHECKS}.
 *   - EXECUTION_GROUNDED_ANCHORS ; needs a real test run (see `grounded-tests.ts`).
 *   - CONFIG_GROUNDED_ANCHORS    ; needs the real worktree file content (see
 *                                  `config-validation.ts`).
 *
 * The two grounded families still have entries in {@link ANCHOR_CHECKS} for the
 * `ci-green` / `ci-e2e-green` pair (the v1 attestation fallback), but
 * `buildAnchorLens` never routes them there: a grounded anchor with no real run
 * fails closed rather than reading the producer's self-reported `ci_passed`.
 *
 * @module delivery/anchor-checks
 */

import {
  hasRealElement,
  isNonEmptyObject,
  isRealRef,
  nonEmpty,
  parseJson,
} from "./artifact-json.js";
import type { AnchorCheck } from "./types.js";

/** The anchors that MUST be grounded in a real test run (not self-attested). */
export const EXECUTION_GROUNDED_ANCHORS: ReadonlySet<string> = new Set([
  "ci-green",
  "ci-e2e-green",
  "pass-count",
  "pass-count-positive",
]);

/**
 * Grounded anchors that additionally require >=1 passing test (not just exit 0).
 * Internal to the module: consumed by `buildAnchorLens`, never part of the
 * public surface.
 */
export const REQUIRE_POSITIVE_PASS: ReadonlySet<string> = new Set([
  "pass-count",
  "pass-count-positive",
]);

/**
 * Anchors grounded in the WORKTREE FILE CONTENT (not a test run). `config-valid`
 * reads each declared config file from the worktree and parses it (YAML/JSON) or
 * inspects it (Dockerfile FROM). Distinct from EXECUTION_GROUNDED_ANCHORS, which
 * runs a test command and yields a GroundedTestResult (exitCode/passCount). These
 * yield a ConfigValidationResult instead, so buildAnchorLens routes them via a
 * separate branch. NOT a member of EXECUTION_GROUNDED_ANCHORS.
 */
export const CONFIG_GROUNDED_ANCHORS: ReadonlySet<string> = new Set(["config-valid"]);

/**
 * Anchors whose verdict is neither a function of the artifact bytes nor of a test
 * run, and is therefore computed by the ENGINE that owns the fact and injected as
 * an {@link ./types.EngineVerdict} (see `buildAnchorLens`'s `engineVerdicts`).
 *
 * - `test-surface-frozen` ; a git fact about the run's BASE commit: did the
 *   `implement` diff touch the runner/config wiring, and is the executed
 *   `test_cmd` still the literal one the run froze? Nothing in the artifact bytes
 *   nor in the test output can answer that.
 * - `pass-count-monotone` ; a fact about the run's HISTORY: collected
 *   non-decreasing and skipped non-increasing against the previous attempt's
 *   baseline. The test run supplies this attempt's counts, not the comparison.
 * - `claims-grounded` ; a gtm-post draft's numeric claims, checked against the
 *   immediately preceding `materiality` stage's declared sources
 *   (`executor/content-verify.ts`'s `computeClaimsGrounded`). Neither the
 *   artifact bytes alone nor a test run can answer it.
 * - `no-competitor-mention` ; a gtm-post draft's posts, checked against the
 *   product's REGISTERED competitor list (`GtmProductConfig.competitorList`),
 *   never the draft's own self-reported `competitor_list` field
 *   (`executor/content-verify.ts`'s `computeNoCompetitorMention`). A
 *   self-declared blocklist can be omitted or mis-copied by the same producer
 *   whose output it is meant to police ; that is exactly the v1 `ci_passed`
 *   class of hole this classification exists to close.
 *
 * A required anchor in this set with NO injected verdict FAILS CLOSED, exactly
 * like an execution-grounded anchor with no run. This is deliberately NOT an
 * "artifact says it passed" path: a self-declared boolean read out of the
 * artifact is the v1 `ci_passed` hole this module exists to have closed.
 */
export const ENGINE_GROUNDED_ANCHORS: ReadonlySet<string> = new Set([
  "test-surface-frozen",
  "pass-count-monotone",
  "claims-grounded",
  "no-competitor-mention",
  "no-banned-phrasing",
  "urls-allowlisted",
]);

/**
 * The per-post character ceiling `char-limit-respected` enforces (X's own
 * limit). Exported because the gtm-post template must state the SAME number to
 * the producer, in its `draft` prompt and its `artifactSchema.maxLength` : a
 * floor that enforces a limit the instructions never mention is a guaranteed
 * failure loop, and it cost a real prod run (a04dda98, 2026-07-28 : a 743-char
 * single post, killed by this anchor, from a prompt that never named 280).
 * One constant, three consumers, no drift.
 */
export const POST_CHAR_LIMIT = 280;

const RE_DEBUG = /\bconsole\.log\b|\bprint\(|\bdbg!\(|\bTODO(?!\s*[:(]?\s*\w+-\d+)/;

/**
 * The registry of deterministic anchor implementations, keyed by AnchorId. Each
 * is a pure function of the artifact bytes (the ungameable floor). `ci` anchors
 * use the v1 attestation fallback: the verifier ran the tests in its worktree and
 * the artifact records the result; running THIS check IS the attestation (the
 * envelope signature binds it). Real CI-status binding is v1.1.
 */
export const ANCHOR_CHECKS: Readonly<Record<string, AnchorCheck>> = {
  "json-schema": (a) => ({
    pass: parseJson(a) !== null,
    rationale: "valid JSON object",
  }),
  "nonempty-fields": (a) => {
    const o = parseJson(a);
    const ok = !!o && nonEmpty(o["scope"]) && nonEmpty(o["success_criteria"]);
    return { pass: ok, rationale: "scope and success_criteria non-empty" };
  },
  // B2-hardened: requires a parsed non-empty JSON object with at least one
  // real key:value pair. A bare string or array fails; keyword-stuffed flat
  // prose fails (no colon-space pattern match on raw bytes).
  "yaml-schema": (a) => {
    const o = parseJson(a);
    if (!o || Object.keys(o).length === 0) {
      return {
        pass: false,
        rationale:
          "yaml-schema: artifact must parse as a non-empty JSON object (at least one key:value pair)",
      };
    }
    return { pass: true, rationale: "non-empty YAML mapping (JSON object)" };
  },
  // B2-hardened: requires a parsed `acceptance_criteria` field that is an
  // array with at least one non-empty string entry. Keyword presence in prose
  // does not satisfy this anchor.
  "acceptance-criteria-present": (a) => {
    const o = parseJson(a);
    // The array may sit at the artifact top level (a producer that emits the
    // spec object directly) OR nested under `structuredOutput` : the Claude
    // Agent SDK executor wraps a stage's `outputFormat` (json_schema) result as
    // `{ ..., structuredOutput }`, so a structured `spec` lands there. Reading
    // both keeps the signed artifact surface unchanged (no new top-level field) ;
    // it only teaches the lens where a structured producer put the criteria.
    const nested =
      o && typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : undefined;
    const criteria =
      o && Array.isArray(o["acceptance_criteria"])
        ? o["acceptance_criteria"]
        : nested && Array.isArray(nested["acceptance_criteria"])
          ? nested["acceptance_criteria"]
          : undefined;
    if (criteria === undefined) {
      return {
        pass: false,
        rationale:
          "acceptance-criteria-present: artifact must have an acceptance_criteria JSON array (top-level or under structuredOutput)",
      };
    }
    const ac = criteria as unknown[];
    const hasEntry = ac.some((e) => typeof e === "string" && e.trim().length > 0);
    if (!hasEntry) {
      return {
        pass: false,
        rationale:
          "acceptance-criteria-present: acceptance_criteria array must contain at least one non-empty entry",
      };
    }
    return { pass: true, rationale: ">=1 acceptance criterion (structured)" };
  },
  // B2-hardened (type-strict): requires `interfaces` to be EITHER a non-empty
  // object (>=1 key) OR an array carrying >=1 real element (non-empty string or
  // non-empty object). Rejects [null], [false], [0], [""] (no real element).
  "interfaces-present": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale: "interfaces-present: artifact must be a JSON object with an interfaces field",
      };
    }
    const iface = o["interfaces"];
    if (!isNonEmptyObject(iface) && !hasRealElement(iface)) {
      return {
        pass: false,
        rationale:
          "interfaces-present: interfaces must be a non-empty object or an array with >=1 real element (rejected: null/false/0/empty entries)",
      };
    }
    return {
      pass: true,
      rationale: "interface contracts present (structured)",
    };
  },
  // B2-hardened: requires parsed top-level fields `context`, `decision`, and
  // `consequences` (or a `sections` object containing those keys), each with
  // non-empty string content of at least 20 characters. Keyword presence alone
  // in prose does not satisfy this anchor.
  "adr-sections": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale:
          "adr-sections: artifact must be a JSON object with context/decision/consequences fields",
      };
    }
    // Accept top-level keys or a nested `sections` object.
    const src =
      o["sections"] !== null && typeof o["sections"] === "object" && !Array.isArray(o["sections"])
        ? (o["sections"] as Record<string, unknown>)
        : o;
    const MIN_LEN = 20;
    const ctx = typeof src["context"] === "string" ? src["context"].trim() : "";
    const dec = typeof src["decision"] === "string" ? src["decision"].trim() : "";
    const cons = typeof src["consequences"] === "string" ? src["consequences"].trim() : "";
    if (ctx.length < MIN_LEN) {
      return {
        pass: false,
        rationale: `adr-sections: context must be a non-empty string of >= ${MIN_LEN} chars`,
      };
    }
    if (dec.length < MIN_LEN) {
      return {
        pass: false,
        rationale: `adr-sections: decision must be a non-empty string of >= ${MIN_LEN} chars`,
      };
    }
    if (cons.length < MIN_LEN) {
      return {
        pass: false,
        rationale: `adr-sections: consequences must be a non-empty string of >= ${MIN_LEN} chars`,
      };
    }
    return {
      pass: true,
      rationale: "Context/Decision/Consequences present (structured, >=20 chars each)",
    };
  },
  // B2-hardened: requires a parsed `axiom_check` or `axioms` structure where
  // all five axioms (institutionnel, sota, robuste, anti_fragile/anti-fragile,
  // profitable) are mapped to distinct, non-empty justification strings. Five
  // keyword hits in prose do not satisfy this anchor.
  "axiom-check-5": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale:
          "axiom-check-5: artifact must be a JSON object with an axiom_check or axioms field",
      };
    }
    const raw = o["axiom_check"] ?? o["axioms"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        pass: false,
        rationale:
          "axiom-check-5: axiom_check (or axioms) must be a non-null object mapping each axiom to a justification",
      };
    }
    const ax = raw as Record<string, unknown>;
    // Normalise keys: lower, replace hyphens with underscores.
    const normalise = (k: string) => k.toLowerCase().replace(/-/g, "_");
    const normalised = Object.fromEntries(Object.entries(ax).map(([k, v]) => [normalise(k), v]));
    const required = ["institutionnel", "sota", "robuste", "anti_fragile", "profitable"] as const;
    for (const axiom of required) {
      const val = normalised[axiom];
      if (typeof val !== "string" || val.trim().length === 0) {
        return {
          pass: false,
          rationale: `axiom-check-5: axiom "${axiom}" is missing or has an empty justification`,
        };
      }
    }
    return {
      pass: true,
      rationale: "Axiom-Check: all 5 axioms present with non-empty justifications (structured)",
    };
  },
  "no-debug-artifacts": (a) => ({
    pass: !RE_DEBUG.test(a),
    rationale: "no debug artifacts in diff",
  }),
  /**
   * `diff-nonempty` (pure) : the `implement` stage report MUST declare at least
   * one real changed file. A stage that "succeeded" with an empty
   * `changed_files[]` produced no diff at all, so every downstream anchor
   * (ci-green over a commit identical to base, a publish with nothing to push)
   * would attest a no-op as a delivery. Fail-closed on unparseable bytes, a
   * missing/non-array field, an empty array, or an array holding only blanks.
   */
  "diff-nonempty": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale: "diff-nonempty: artifact is not valid JSON (fail-closed)",
      };
    }
    // Like `acceptance-criteria-present` above: the array may sit at the
    // artifact top level OR under `structuredOutput` (where the Claude Agent
    // SDK executor puts a stage's json_schema result). Reading both keeps the
    // signed artifact surface unchanged.
    const nested =
      typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : undefined;
    const files = Array.isArray(o.changed_files)
      ? o.changed_files
      : nested && Array.isArray(nested["changed_files"])
        ? nested["changed_files"]
        : undefined;
    if (!Array.isArray(files)) {
      return {
        pass: false,
        rationale:
          "diff-nonempty: changed_files must be a JSON array (top-level or under structuredOutput)",
      };
    }
    const real = files.filter((f) => typeof f === "string" && f.trim().length > 0);
    if (real.length === 0) {
      return {
        pass: false,
        rationale:
          "diff-nonempty: changed_files holds no real entry ; the stage produced no diff (fail-closed)",
      };
    }
    return {
      pass: true,
      rationale: `diff-nonempty: ${real.length} changed file(s) declared`,
    };
  },
  "pass-count-positive": (a) => {
    const o = parseJson(a);
    const ok =
      !!o &&
      typeof o["pass_count"] === "number" &&
      (o["pass_count"] as number) > 0 &&
      o["fail_count"] === 0;
    return { pass: ok, rationale: "pass_count > 0 and fail_count == 0" };
  },
  // The `publish` stage's pure floor (Phase 0). Accept EITHER a real publish
  // (branch AND pr_url both non-empty strings) OR a DOCUMENTED skip (skipped===true
  // with a non-empty reason). Refuse an undocumented skip, a partial publish, or
  // unparseable bytes; fail-closed on ambiguity. This deterministic check is the
  // COMPLETE verification of the machine-generated publish-report, so the publish
  // stage carries adversary intensity "none" (an LLM judge adds no signal).
  "branch-pushed-or-skipped": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale: "branch-pushed-or-skipped: publish-report.json is not valid JSON",
      };
    }
    const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
    if (isStr(o["branch"]) && isStr(o["pr_url"])) {
      return { pass: true, rationale: `publish: PR opened (${o["pr_url"]})` };
    }
    if (o["skipped"] === true && isStr(o["reason"])) {
      return {
        pass: true,
        rationale: `publish: documented skip (${o["reason"]})`,
      };
    }
    if (o["skipped"] === true) {
      return {
        pass: false,
        rationale: "branch-pushed-or-skipped: skipped:true without a reason",
      };
    }
    return {
      pass: false,
      rationale: "branch-pushed-or-skipped: incomplete publish (branch and/or pr_url missing)",
    };
  },
  /**
   * `materiality-declared` (pure, gtm-post) : the materiality stage's artifact
   * must carry a well-shaped decision. Checks SHAPE only ; the judgment call
   * ("is this angle actually good") is not this anchor's job ; a hollow
   * `has_materiality:true` with thin reasoning is caught downstream by
   * `draft`+`verify`'s content gates, the same defense-in-depth already used
   * between `spec` and `implement` in the feature template.
   */
  "materiality-declared": (a) => {
    const o = parseJson(a);
    const so =
      o && typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : o;
    if (!so || typeof so["has_materiality"] !== "boolean") {
      return {
        pass: false,
        rationale: "materiality-declared: artifact must have a boolean has_materiality field",
      };
    }
    if (typeof so["angle"] !== "string" || typeof so["reasoning"] !== "string") {
      return {
        pass: false,
        rationale: "materiality-declared: artifact must have string angle and reasoning fields",
      };
    }
    return { pass: true, rationale: "materiality-declared: shape present" };
  },
  /** `char-limit-respected` (pure, gtm-post) : every declared post is <={@link POST_CHAR_LIMIT} chars. */
  "char-limit-respected": (a) => {
    const o = parseJson(a);
    const so =
      o && typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : o;
    const posts = so && Array.isArray(so["posts"]) ? (so["posts"] as unknown[]) : undefined;
    if (!posts || posts.length === 0) {
      return {
        pass: false,
        rationale: "char-limit-respected: artifact must have a non-empty posts array",
      };
    }
    for (const [i, p] of posts.entries()) {
      if (typeof p !== "string") {
        return { pass: false, rationale: `char-limit-respected: posts[${i}] is not a string` };
      }
      if (p.length > POST_CHAR_LIMIT) {
        return {
          pass: false,
          rationale: `char-limit-respected: posts[${i}] is ${p.length} chars, exceeds ${POST_CHAR_LIMIT}`,
        };
      }
    }
    return {
      pass: true,
      rationale: `char-limit-respected: ${posts.length} post(s), all <=${POST_CHAR_LIMIT} chars`,
    };
  },
  /**
   * `no-forbidden-style` (pure, gtm-post) : zero em-dash, zero adjective from
   * the forbidden list (`typography.md`). Mirrors `no-debug-artifacts`'s
   * regex-over-raw-bytes shape.
   */
  "no-forbidden-style": (a) => {
    const o = parseJson(a);
    const so =
      o && typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : o;
    const posts = so && Array.isArray(so["posts"]) ? (so["posts"] as unknown[]) : [];
    const text = posts.filter((p): p is string => typeof p === "string").join("\n");
    if (/[—–]|--/.test(text)) {
      return { pass: false, rationale: "no-forbidden-style: em-dash (or double-hyphen) found" };
    }
    const forbidden = /\b(revolutionary|game-changing|groundbreaking|next-gen|unprecedented)\b/i;
    const match = text.match(forbidden);
    if (match) {
      return {
        pass: false,
        rationale: `no-forbidden-style: forbidden adjective "${match[0]}" found`,
      };
    }
    return { pass: true, rationale: "no-forbidden-style: clean" };
  },
  /**
   * `hashtags-present` (pure, gtm-post) : at least one post carries a hashtag
   * or an @mention ; project memory : "sans hashtags = invisible".
   */
  "hashtags-present": (a) => {
    const o = parseJson(a);
    const so =
      o && typeof o["structuredOutput"] === "object" && o["structuredOutput"] !== null
        ? (o["structuredOutput"] as Record<string, unknown>)
        : o;
    const posts = so && Array.isArray(so["posts"]) ? (so["posts"] as unknown[]) : [];
    const text = posts.filter((p): p is string => typeof p === "string").join("\n");
    if (/[#@]\w+/.test(text)) {
      return { pass: true, rationale: "hashtags-present: found" };
    }
    return { pass: false, rationale: "hashtags-present: no hashtag or @mention in any post" };
  },
  // NOTE: `no-competitor-mention` is NOT a pure ANCHOR_CHECKS entry (same
  // reason `claims-grounded` has none). It is ENGINE-grounded : the
  // competitor list it checks comes from the product's REGISTERED config,
  // resolved server-side, never the draft artifact's own self-reported
  // `competitor_list` field (a self-declared blocklist is not trustworthy for
  // this). See ENGINE_GROUNDED_ANCHORS above and
  // `usine-engine/src/executor/content-verify.ts`'s `computeNoCompetitorMention`.

  /** `posted-or-skipped` (pure, gtm-post) : mirrors branch-pushed-or-skipped exactly, for an X post instead of a git branch+PR. */
  "posted-or-skipped": (a) => {
    const o = parseJson(a);
    if (!o) {
      return { pass: false, rationale: "posted-or-skipped: publish-report is not valid JSON" };
    }
    const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
    if (o["posted"] === true && isStr(o["post_url"])) {
      return { pass: true, rationale: `posted-or-skipped: posted (${o["post_url"]})` };
    }
    if (o["skipped"] === true && isStr(o["reason"])) {
      return { pass: true, rationale: `posted-or-skipped: documented skip (${o["reason"]})` };
    }
    return {
      pass: false,
      rationale:
        "posted-or-skipped: incomplete publish (posted+post_url or documented skip required)",
    };
  },
  "ci-green": (a) => {
    const o = parseJson(a);
    const ok = !!o && nonEmpty(o["ci_run_ref"]) && o["ci_passed"] === true;
    return {
      pass: ok,
      rationale: "verifier-attested CI green (v1 attestation)",
    };
  },
  "ci-e2e-green": (a) => {
    const o = parseJson(a);
    const ok = !!o && nonEmpty(o["ci_run_ref"]) && o["ci_passed"] === true;
    return {
      pass: ok,
      rationale: "verifier-attested E2E green (v1 attestation)",
    };
  },
  "brain-entry-id": (a) => {
    const o = parseJson(a);
    return {
      pass: !!o && nonEmpty(o["brain_entry_id"]),
      rationale: "archive_knowledge returned an id",
    };
  },
  "tags-json-array": (a) => {
    const o = parseJson(a);
    return {
      pass: !!o && Array.isArray(o["tags"]),
      rationale: "tags is a JSON array",
    };
  },
  "exported-symbols-documented": (a) => {
    const o = parseJson(a);
    return {
      pass: !!o && nonEmpty(o["symbols_documented"]),
      rationale: "changed exported symbols documented",
    };
  },
  // B2-hardened (type-strict): requires `spec_ref` to be a NON-EMPTY STRING, OR
  // `references` to be an array/object with >=1 real element (non-empty string
  // or non-empty object). Rejects spec_ref false/0, references [null].
  "docs-reference-spec": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale:
          "docs-reference-spec: artifact must be a JSON object with a spec_ref or references field",
      };
    }
    if (isRealRef(o["spec_ref"])) {
      return {
        pass: true,
        rationale: "docs reference the spec (spec_ref is a non-empty string)",
      };
    }
    const refs = o["references"];
    if (isNonEmptyObject(refs) || hasRealElement(refs)) {
      return {
        pass: true,
        rationale: "docs reference the spec (references has a real element)",
      };
    }
    return {
      pass: false,
      rationale:
        "docs-reference-spec: spec_ref must be a non-empty string OR references must hold >=1 real element (rejected: false/0/null/empty)",
    };
  },
  "two-lens-verdict": (a) => {
    const o = parseJson(a);
    const verdicts = o?.["verdicts"];
    const sources = Array.isArray(verdicts)
      ? new Set(verdicts.map((v) => (v as Record<string, unknown>)?.["source"]).filter(Boolean))
      : new Set();
    return {
      pass: sources.size >= 2,
      rationale: ">=2 distinct verdict sources",
    };
  },

  // ── Audit template anchors ─────────────────────────────────────────────────

  "audit-questions-present": (a) => {
    const o = parseJson(a);
    const ok = !!o && Array.isArray(o["questions"]) && nonEmpty(o["questions"]);
    return { pass: ok, rationale: "questions[] is non-empty" };
  },
  "audit-evidence-present": (a) => {
    const o = parseJson(a);
    const ok = !!o && Array.isArray(o["sources"]) && nonEmpty(o["sources"]);
    return { pass: ok, rationale: "sources[] is non-empty" };
  },
  "audit-analysis-present": (a) => {
    const o = parseJson(a);
    const ok = !!o && Array.isArray(o["observations"]) && nonEmpty(o["observations"]);
    return { pass: ok, rationale: "observations[] is non-empty" };
  },
  "audit-findings-structured": (a) => {
    const o = parseJson(a);
    if (!o || !Array.isArray(o["findings"])) {
      return {
        pass: false,
        rationale: "findings must be a JSON array",
      };
    }
    const findings = o["findings"] as unknown[];
    // An empty findings array is VALID (clean audit).
    for (const f of findings) {
      if (
        typeof f !== "object" ||
        f === null ||
        Array.isArray(f) ||
        !nonEmpty((f as Record<string, unknown>)["severity"]) ||
        !nonEmpty((f as Record<string, unknown>)["title"]) ||
        !nonEmpty((f as Record<string, unknown>)["evidence_ref"])
      ) {
        return {
          pass: false,
          rationale: "every finding must have non-empty severity, title, evidence_ref",
        };
      }
    }
    return {
      pass: true,
      rationale:
        findings.length === 0
          ? "findings[] is empty (clean audit)"
          : "all findings have required fields",
    };
  },
  "audit-report-summary-present": (a) => {
    const o = parseJson(a);
    const ok = !!o && nonEmpty(o["summary"]);
    return { pass: ok, rationale: "summary field is non-empty" };
  },
  // B2-hardened (type-strict): requires `findings_ref` to be a NON-EMPTY STRING,
  // OR `findings` to be an array/object with >=1 real element (non-empty string
  // or non-empty object). Rejects findings_ref 0/false, findings [null].
  "audit-report-references-findings": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale: "audit-report-references-findings: artifact must be a JSON object",
      };
    }
    if (isRealRef(o["findings_ref"])) {
      return {
        pass: true,
        rationale: "artifact references findings via findings_ref (non-empty string)",
      };
    }
    const findings = o["findings"];
    if (isNonEmptyObject(findings) || hasRealElement(findings)) {
      return {
        pass: true,
        rationale: "artifact contains a findings structure with a real element",
      };
    }
    return {
      pass: false,
      rationale:
        "audit-report-references-findings: findings_ref must be a non-empty string OR findings must hold >=1 real element (rejected: 0/false/null/empty)",
    };
  },

  // ── Infra template anchors ─────────────────────────────────────────────────

  /**
   * `config-files-present` (pure): the artifact is the developpement stage
   * report JSON. Passes when `files_changed` is a non-empty array. Fails
   * closed on missing, empty, or unparseable input. This is the ungameable
   * floor: the producer MUST declare at least one file to seal the stage.
   */
  "config-files-present": (a) => {
    const o = parseJson(a);
    if (!o) {
      return {
        pass: false,
        rationale: "config-files-present: artifact is not valid JSON (fail-closed)",
      };
    }
    const files = o["files_changed"];
    if (!Array.isArray(files) || files.length === 0) {
      return {
        pass: false,
        rationale: "config-files-present: no files declared in files_changed (fail-closed)",
      };
    }
    return {
      pass: true,
      rationale: `>=1 config file declared in files_changed (${files.length} file(s))`,
    };
  },

  // NOTE: `config-valid` is NOT a pure ANCHOR_CHECKS entry. It is content-aware
  // (reads + parses each declared config file from the worktree) and is wired
  // through the grounded path (CONFIG_GROUNDED_ANCHORS + runConfigValidation),
  // mirroring the ci-green execution-grounded pattern. See runConfigValidation.

  // ── Document template anchors ──────────────────────────────────────────────

  /**
   * `document-intent` (pure) : the artifact is a JSON object with
   * kind=="document", title non-empty, document_sha256 = exactly 64
   * lowercase hex chars, frozen_spec_ref non-empty.
   * Extra fields are tolerated (open schema).
   */
  "document-intent": (a) => {
    let o: Record<string, unknown> | null;
    try {
      o = parseJson(a);
    } catch {
      o = null;
    }
    if (!o) {
      return { pass: false, rationale: "invalid JSON: cannot parse artifact" };
    }
    if (o["kind"] !== "document") {
      return {
        pass: false,
        rationale: `kind must be "document", got ${JSON.stringify(o["kind"])}`,
      };
    }
    if (!nonEmpty(o["title"])) {
      return { pass: false, rationale: "title must be non-empty" };
    }
    const sha = o["document_sha256"];
    if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return {
        pass: false,
        rationale: "document_sha256 must be exactly 64 lowercase hex characters",
      };
    }
    if (!nonEmpty(o["frozen_spec_ref"])) {
      return { pass: false, rationale: "frozen_spec_ref must be non-empty" };
    }
    return {
      pass: true,
      rationale: "document-intent: kind, title, sha256, frozen_spec_ref valid",
    };
  },

  /**
   * `document-verify-record` (pure) : the artifact is a JSON object with
   * kind=="document", document_sha256 = 64 hex chars, record.verdicts = a
   * non-empty array whose every element has claim_id non-empty and verdict in
   * {confirmed, partially_confirmed, refuted, unverifiable}, AND ZERO
   * verdict=="refuted". One refuted = fail-closed (ANCHOR_FLOOR_UNMET).
   */
  "document-verify-record": (a) => {
    let o: Record<string, unknown> | null;
    try {
      o = parseJson(a);
    } catch {
      o = null;
    }
    if (!o) {
      return { pass: false, rationale: "invalid JSON: cannot parse artifact" };
    }
    if (o["kind"] !== "document") {
      return {
        pass: false,
        rationale: `kind must be "document", got ${JSON.stringify(o["kind"])}`,
      };
    }
    const sha = o["document_sha256"];
    if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return {
        pass: false,
        rationale: "document_sha256 must be exactly 64 lowercase hex characters",
      };
    }
    const record = o["record"];
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      return { pass: false, rationale: "record must be a non-null object" };
    }
    const verdicts = (record as Record<string, unknown>)["verdicts"];
    if (!Array.isArray(verdicts) || verdicts.length === 0) {
      return {
        pass: false,
        rationale: "record.verdicts must be a non-empty array",
      };
    }
    const VALID_VERDICTS = new Set(["confirmed", "partially_confirmed", "refuted", "unverifiable"]);
    for (const item of verdicts) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return {
          pass: false,
          rationale: "every verdict item must be a non-null object",
        };
      }
      const entry = item as Record<string, unknown>;
      if (!nonEmpty(entry["claim_id"])) {
        return {
          pass: false,
          rationale: "every verdict item must have a non-empty claim_id",
        };
      }
      if (!VALID_VERDICTS.has(entry["verdict"] as string)) {
        return {
          pass: false,
          rationale: `verdict "${String(entry["verdict"])}" is not in {confirmed, partially_confirmed, refuted, unverifiable}`,
        };
      }
      if (entry["verdict"] === "refuted") {
        return {
          pass: false,
          rationale:
            "document-verify-record: REFUTED verdict found (fail-closed: zero refuted required to seal)",
        };
      }
    }
    return {
      pass: true,
      rationale: `document-verify-record: ${verdicts.length} verdict(s), none refuted`,
    };
  },
};
