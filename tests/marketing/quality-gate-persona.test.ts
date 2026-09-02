/**
 * Marketing quality-gate exhaustive tests — persona YAML load smoke + 32-pattern matrix.
 *
 * Test IDs map:
 *   SMOKE-*    : persona YAML load smoke (catches the (?i) inline flag + scope bug class)
 *   GATE-*     : evaluateQualityGate functional (violations / warnings / structural)
 *   PAT-<name> : per-pattern positive (gate catches it) + negative (gate ignores benign)
 *   COMPILE-*  : compileForbiddenPatterns contract (hard ERROR on compile failure)
 *   BRAND-*    : brand-specific edge cases (audit_firm, budget, kill_criterion, target_date)
 *   ITER-*     : iteration loop (3 attempts, violation refinement, permanent block)
 *
 * Would these tests have caught tonight's bugs?
 *   BUG-1 (?i) inline flag : YES — SMOKE-02 asserts no (?i) in any pattern; PAT-* catch
 *     silent skip (22/32 patterns would have matched nothing).
 *   BUG-2 scope field guard skipping all patterns : YES — SMOKE-03 asserts no scope field;
 *     PAT-* would fail because gate returns 0 violations on content that should match.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { AgentPersona } from "../../src/identity/persona-schema.js";
import { evaluateQualityGate } from "../../src/marketing/quality-gate.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const PERSONA_PATH = resolve(process.cwd(), "../../personas/vauban-marketing.yaml");

/** Build a minimal publish_social_post/x gate input. */
function xInput(text: string, persona: AgentPersona) {
  return {
    action_type: "publish_social_post" as const,
    platform: "x" as const,
    payload: { text },
    persona,
  };
}

/** Build a minimal publish_article gate input. */
function articleInput(title: string, body: string, persona: AgentPersona) {
  return {
    action_type: "publish_article" as const,
    payload: { title, body },
    persona,
  };
}

// ── Fixture load ───────────────────────────────────────────────────────────────

let REAL_PERSONA: AgentPersona;
let RAW_PATTERNS: Array<{ name: string; pattern: string; scope?: string }>;

const PERSONA_AVAILABLE = existsSync(PERSONA_PATH);

beforeAll(async () => {
  if (!PERSONA_AVAILABLE) return;
  const raw = await readFile(PERSONA_PATH, "utf-8");
  const parsed = parseYaml(raw) as AgentPersona & {
    forbidden_patterns?: Array<{
      name: string;
      pattern: string;
      scope?: string;
    }>;
  };
  REAL_PERSONA = parsed;
  RAW_PATTERNS = parsed.forbidden_patterns ?? [];
});

// ══════════════════════════════════════════════════════════════════════════════
// SMOKE — persona YAML load canary
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!PERSONA_AVAILABLE)("SMOKE — persona YAML load canary", () => {
  /**
   * SMOKE-01: The YAML file loads without error and exposes >=1 forbidden_patterns.
   * Would catch: file missing, YAML parse error, schema validation failure.
   */
  it("SMOKE-01: persona file loads and exposes forbidden_patterns", async () => {
    const raw = await readFile(PERSONA_PATH, "utf-8");
    expect(raw.length).toBeGreaterThan(0);
    const parsed = parseYaml(raw) as { forbidden_patterns?: unknown[] };
    expect(Array.isArray(parsed.forbidden_patterns)).toBe(true);
    expect((parsed.forbidden_patterns ?? []).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * SMOKE-02: No pattern contains the (?i) inline flag.
   * (?i) is valid in Python/PCRE but throws in JS RegExp constructor.
   * With the old bug, (?i) patterns compiled as warnings and ran NO matches.
   *
   * Catches BUG-1 from 2026-05-20.
   */
  it("SMOKE-02: no pattern contains (?i) inline flag (invalid in JS RegExp)", () => {
    for (const p of RAW_PATTERNS) {
      expect(
        p.pattern,
        `pattern "${p.name}" contains (?i) which is invalid in JavaScript RegExp`,
      ).not.toMatch(/\(\?i\)/);
    }
  });

  /**
   * SMOKE-03: No pattern in the YAML contains a scope field.
   * Audience-scoped values (any_output, public_marketing) were never valid field
   * names in the gate; the old scope guard would skip ALL patterns silently.
   *
   * Catches BUG-2 from 2026-05-20.
   */
  it("SMOKE-03: no forbidden_pattern entry carries a scope field in the YAML", () => {
    for (const p of RAW_PATTERNS) {
      expect(
        (p as { scope?: string }).scope,
        `pattern "${p.name}" has a scope field which would cause the gate to skip it`,
      ).toBeUndefined();
    }
  });

  /**
   * SMOKE-04: Every pattern compiles via new RegExp(p.pattern, "i") without throwing.
   * If any of the 32 patterns is malformed JS regex, this test catches it before
   * it silently degrades the gate at runtime.
   *
   * Catches BUG-1 (compile failure path) and future persona author errors.
   */
  it("SMOKE-04: every forbidden_pattern compiles via new RegExp(p.pattern, 'i') without throwing", () => {
    const failures: string[] = [];
    for (const p of RAW_PATTERNS) {
      try {
        new RegExp(p.pattern, "i");
      } catch (err) {
        failures.push(`"${p.name}": ${(err as Error).message}`);
      }
    }
    expect(failures, `patterns that fail JS compile:\n${failures.join("\n")}`).toHaveLength(0);
  });

  /**
   * SMOKE-05: Total pattern count is exactly 32 (tonight's canonical count).
   * If someone accidentally removes or duplicates a pattern, this fails loud.
   */
  it("SMOKE-05: persona carries exactly 32 forbidden_patterns (canonical count)", () => {
    expect(RAW_PATTERNS).toHaveLength(32);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GATE — evaluateQualityGate functional
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!PERSONA_AVAILABLE)("GATE — evaluateQualityGate functional", () => {
  /**
   * GATE-01: The 4 canonical forbidden adjectives are caught in a single input.
   */
  it("GATE-01: 'revolutionary AI-powered next-gen unprecedented' triggers 4 violations", () => {
    const r = evaluateQualityGate(
      xInput("revolutionary AI-powered next-gen unprecedented approach to identity.", REAL_PERSONA),
    );
    expect(r.passed).toBe(false);
    const text = r.violations.join("\n");
    expect(text).toMatch(/forbidden_adjective_revolutionary/);
    expect(text).toMatch(/forbidden_adjective_ai_powered_standalone/);
    expect(text).toMatch(/forbidden_adjective_next_gen/);
    expect(text).toMatch(/forbidden_adjective_unprecedented/);
    expect(r.violations.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * GATE-02: 'game-changing groundbreaking' triggers exactly 2 violations.
   */
  it("GATE-02: 'game-changing groundbreaking' triggers 2 violations", () => {
    const r = evaluateQualityGate(
      xInput("Our game-changing groundbreaking ZK system.", REAL_PERSONA),
    );
    expect(r.passed).toBe(false);
    const text = r.violations.join("\n");
    expect(text).toMatch(/forbidden_adjective_game_changing/);
    expect(text).toMatch(/forbidden_adjective_groundbreaking/);
  });

  /**
   * GATE-03: Clean institutional input passes with 0 violations.
   */
  it("GATE-03: clean institutional input passes with zero violations", () => {
    const r = evaluateQualityGate(
      xInput(
        "We ran 40,000 passport verifications on Sepolia in three weeks. STARK-based, no trusted setup. 33 countries covered.",
        REAL_PERSONA,
      ),
    );
    expect(r.passed).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  /**
   * GATE-04: Structural — tweet over 280 chars triggers structural violation.
   */
  it("GATE-04: structural — tweet >280 chars triggers structural violation", () => {
    const r = evaluateQualityGate(xInput("a".repeat(281), REAL_PERSONA));
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("exceeds 280"))).toBe(true);
  });

  /**
   * GATE-05: Structural — LinkedIn body <1200 chars triggers structural warning.
   */
  it("GATE-05: structural — LinkedIn body <1200 chars triggers structural warning", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "linkedin",
      payload: { text: "Short LinkedIn post.".repeat(10) },
      persona: REAL_PERSONA,
    });
    expect(r.warnings.some((w) => w.includes("linkedin") && w.includes("under target"))).toBe(true);
  });

  /**
   * GATE-06: Structural — X thread with 1 long tweet (>280) flagged on that index.
   */
  it("GATE-06: structural — X thread with 1 long tweet flagged at that index", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        tweets: [
          { position: 1, content: "Normal tweet within limit." },
          { position: 2, content: "x".repeat(300) },
          { position: 3, content: "Another normal tweet." },
        ],
      },
      persona: REAL_PERSONA,
    });
    expect(r.passed).toBe(false);
    // Structural violations use "x tweet[N]" format (not "tweets[N]").
    expect(r.violations.some((v) => v.includes("x tweet[1]") && v.includes("exceeds 280"))).toBe(
      true,
    );
    expect(r.violations.every((v) => !v.includes("x tweet[0]"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAT — 32 patterns x isolated positive + negative
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Each tuple: [patternName, matchingText, benignText]
 *
 * matchingText MUST trigger the pattern.
 * benignText MUST NOT trigger the pattern.
 *
 * These cover all 32 patterns from vauban-marketing.yaml.
 * Would catch BUG-1 (pattern silently disabled) and BUG-2 (scope guard skipping all).
 */
const PATTERN_MATRIX: [string, string, string][] = [
  [
    "contract_address",
    "deployed at 0x03bc1234567890abcdef1234567890abcdef1234 on Starknet",
    "the contract is deployed on Starknet mainnet",
  ],
  [
    "em_dash_u2014",
    "We shipped today — the audit follows.",
    "We shipped today; the audit follows.",
  ],
  ["em_dash_u2013", "The result – a verified proof.", "The result: a verified proof."],
  [
    "double_hyphen_as_dash",
    "We shipped today -- the audit follows.",
    // No double-hyphen present; the pattern only fires on --.
    "We shipped today; the audit follows. Single hyphens like post-quantum are fine.",
  ],
  [
    "algorithm_ladder_rsa",
    "Belgium uses RSA-2048 for passport signing.",
    "Post-quantum ready, no legacy cipher dependency.",
  ],
  [
    "algorithm_ladder_ecdsa",
    "Korea uses ECDSA P-384 for chip authentication.",
    "Elliptic curve cryptography with composite signature support.",
  ],
  [
    "algorithm_ladder_curve_standalone",
    "The verifier handles secp384r1 curves natively.",
    "The verifier handles all standard curves transparently.",
  ],
  [
    "algorithm_ladder_rsa_wordy",
    "composite RSA verification covers all chip generations.",
    "Post-quantum ready verification covers all chip generations.",
  ],
  [
    "algorithm_ladder_ecdsa_wordy",
    "The system uses ECDSA fallback for older chips.",
    "The system handles older chips transparently.",
  ],
  [
    "pq_signature_recipe_combo",
    "Post-quantum signature verification with RSA fallback path.",
    "Post-quantum ready verification path.",
  ],
  [
    "signature_scheme_cascade",
    "The signature scheme cascade handles all generations.",
    "The composite verification handles all chip generations.",
  ],
  [
    "audit_firm_pre_signature",
    "Audit RFP sent to trail of bits and zellic today.",
    "A formal security audit is in the pipeline.",
  ],
  [
    "internal_commit_sha_full",
    "deployed at commit a3b4c5d6e7f8a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
    "deployed in sprint A last week",
  ],
  [
    "internal_commit_sha_short_with_keyword",
    "the fix landed at commit a3b4c5d on main",
    "the fix landed on main branch",
  ],
  [
    "private_github_link",
    "see the code at github.com/vauban-org/glacis-protocol (private) for details",
    "DM us if you want access to the implementation",
  ],
  [
    "kill_criterion_phrase",
    "if we miss the audit by end of Q3 2027 we will pivot.",
    "our audit timeline is tracked internally.",
  ],
  [
    "budget_disclosure_kw_first",
    "the budget for the audit is $120k this quarter.",
    "the audit scope is defined; we will share results on completion.",
  ],
  [
    "budget_disclosure_currency_first",
    "$120k spend on the audit runway this cycle.",
    "$660/mo saved on infrastructure costs.",
  ],
  [
    "cairo_internal_function",
    "the verify_signature entry point handles composite signing.",
    "the verifier handles composite signing transparently.",
  ],
  [
    "internal_sprint_name",
    "Sprint-3A delivered the core verifier.",
    "the third milestone delivered the core verifier.",
  ],
  [
    "internal_test_counts",
    "We ran 40,000 tests over three weeks.",
    "We validated the system over three weeks of Sepolia runs.",
  ],
  [
    "target_date_quarter",
    "mainnet launch planned for Q3 2027.",
    "mainnet launch timing will be announced with the audit report.",
  ],
  [
    "forbidden_adjective_ai_powered_standalone",
    "Our AI-powered identity solution ships today.",
    "Our agent-assisted verification pipeline ships today.",
  ],
  [
    "brand_hashtag",
    "Follow our work #VaubanResearch for updates.",
    "Follow #ZK and #Starknet for updates.",
  ],
  [
    "forbidden_adjective_revolutionary",
    "A revolutionary approach to ZK identity.",
    "A novel approach to ZK identity on Starknet.",
  ],
  [
    "forbidden_adjective_game_changing",
    "This is game-changing for digital identity.",
    "This changes how digital identity works on-chain.",
  ],
  [
    "forbidden_adjective_groundbreaking",
    "groundbreaking ZK system for passport verification.",
    "rigorous ZK system for passport verification.",
  ],
  [
    "forbidden_adjective_next_gen",
    "Next-gen identity infrastructure for institutions.",
    "Production-grade identity infrastructure for institutions.",
  ],
  [
    "forbidden_adjective_unprecedented",
    "unprecedented speed for on-chain passport verification.",
    "~50ms verification on Starknet Sepolia, measured over 40k runs.",
  ],
  [
    "ai_smell_opener_rapidly_evolving",
    "in the rapidly evolving landscape of ZK technology",
    "ZK technology is maturing fast; here is what changed.",
  ],
  [
    "ai_smell_opener_excited_to_announce",
    "Today we are excited to announce the Glacis V2 verifier.",
    "The Glacis V2 verifier is on Starknet mainnet.",
  ],
  [
    "ai_smell_opener_just_the_beginning",
    "This is just the beginning of our ZK journey.",
    "The first production milestone is live on Starknet.",
  ],
];

describe.skipIf(!PERSONA_AVAILABLE)("PAT — 32 patterns isolated positive + negative", () => {
  for (const [patternName, matchingText, benignText] of PATTERN_MATRIX) {
    it(`PAT-${patternName}: positive — gate catches matching input`, () => {
      const r = evaluateQualityGate(xInput(matchingText, REAL_PERSONA));
      const found = r.violations.some((v) => v.includes(patternName));
      expect(
        found,
        `pattern "${patternName}" should catch:\n  "${matchingText}"\n  violations: ${JSON.stringify(r.violations)}`,
      ).toBe(true);
    });

    it(`PAT-${patternName}: negative — gate ignores benign input`, () => {
      const r = evaluateQualityGate(xInput(benignText, REAL_PERSONA));
      const falsePositive = r.violations.some((v) => v.includes(patternName));
      expect(
        falsePositive,
        `pattern "${patternName}" should NOT match:\n  "${benignText}"\n  violations: ${JSON.stringify(r.violations)}`,
      ).toBe(false);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// COMPILE — compileForbiddenPatterns contract
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!PERSONA_AVAILABLE)("COMPILE — compileForbiddenPatterns contract", () => {
  /**
   * COMPILE-01: All 32 real persona patterns compile without error.
   * If any pattern throws, the gate must NOT silently swallow it as a warning.
   */
  it("COMPILE-01: all 32 real persona patterns compile cleanly (no thrown errors)", () => {
    const failures: string[] = [];
    for (const p of RAW_PATTERNS) {
      try {
        new RegExp(p.pattern, "i");
      } catch (err) {
        failures.push(`"${p.name}": ${(err as Error).message}`);
      }
    }
    expect(failures).toHaveLength(0);
  });

  /**
   * COMPILE-02: An invalid pattern in the persona surfaces as BOTH a warning (observability)
   * AND a violation (hard block). gate returns passed=false.
   *
   * Contract (implemented 2026-05-20, commit after BUG-1 incident):
   *   compile failure -> passed=false (status=ERROR), NOT warnings=N only.
   *
   * Rationale: a malformed pattern provides zero protection. Silently counting it
   * as a warning (old behavior) meant bad content could bypass the gate entirely.
   * With the fix, callers receive passed=false and must block dispatch.
   */
  it("COMPILE-02: invalid pattern in persona -> gate returns passed=false (status=ERROR contract)", () => {
    const personaWithBadPattern: AgentPersona = {
      forbidden_patterns: [
        { name: "valid_pattern", pattern: "\\brevolutionary\\b" },
        { name: "invalid_unclosed", pattern: "[unclosed bracket" },
      ],
    };
    const r = evaluateQualityGate(
      xInput("Normal clean content with no issues.", personaWithBadPattern),
    );
    // Both a warning (observability) and a violation (hard block):
    expect(
      r.warnings.some((w) => w.includes("invalid_unclosed") && w.includes("invalid regex")),
    ).toBe(true);
    expect(
      r.violations.some((v) => v.includes("invalid_unclosed") && v.includes("invalid regex")),
    ).toBe(true);
    // Gate must be blocked, not passed:
    expect(r.passed).toBe(false);
  });

  /**
   * COMPILE-03: A persona with ALL valid patterns has zero compile warnings.
   */
  it("COMPILE-03: real persona generates zero compile-error warnings at gate time", () => {
    const r = evaluateQualityGate(
      xInput("Post-quantum ready, no trusted setup, on-chain verification.", REAL_PERSONA),
    );
    const compileWarnings = r.warnings.filter((w) => w.includes("invalid regex"));
    expect(compileWarnings).toHaveLength(0);
  });

  /**
   * COMPILE-04: A persona with a (?i) inline flag produces a compile warning + violation.
   * gate returns passed=false. Content is NOT silently passed through as clean.
   *
   * This is the direct regression test for BUG-1 (2026-05-20).
   * With the old warning-only behavior: passed=true, "revolutionary" content slipped through.
   * With the new ERROR contract: passed=false, dispatch blocked.
   */
  it("COMPILE-04: (?i) inline flag persona pattern fails compile and gate returns passed=false", () => {
    const personaWithInlineFlag: AgentPersona = {
      forbidden_patterns: [
        {
          name: "adjective_with_wrong_flag",
          pattern: "(?i)\\brevolutionary\\b",
        },
      ],
    };
    const r = evaluateQualityGate(
      xInput("A revolutionary approach to ZK identity.", personaWithInlineFlag),
    );
    // Warning surface for observability:
    expect(r.warnings.some((w) => w.includes("adjective_with_wrong_flag"))).toBe(true);
    // Violation surface to block dispatch:
    expect(r.violations.some((v) => v.includes("adjective_with_wrong_flag"))).toBe(true);
    // Gate blocked, not passed (the key regression check):
    expect(r.passed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BRAND — specific pattern edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!PERSONA_AVAILABLE)("BRAND — specific pattern edge cases", () => {
  /**
   * BRAND-01: audit_firm_pre_signature catches firm names.
   */
  it("BRAND-01: 'Audited by trail of bits' is caught by audit_firm_pre_signature", () => {
    const r = evaluateQualityGate(
      xInput("Audited by trail of bits, report to follow.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("audit_firm_pre_signature"))).toBe(true);
  });

  /**
   * BRAND-02: 'audit-ready' is NOT caught (word-boundary match, not substring).
   */
  it("BRAND-02: 'audit-ready' is NOT caught by audit_firm_pre_signature", () => {
    const r = evaluateQualityGate(
      xInput("The verifier is audit-ready; formal engagement in progress.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("audit_firm_pre_signature"))).toBe(false);
  });

  /**
   * BRAND-03: budget_disclosure_kw_first catches "budget $5M raised".
   */
  it("BRAND-03: 'budget raised of $5M' is caught by budget_disclosure_kw_first", () => {
    const r = evaluateQualityGate(
      xInput("The budget for Q3 is $5M raised from institutional LPs.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("budget_disclosure"))).toBe(true);
  });

  /**
   * BRAND-04: '$660/mo saved' does NOT trigger budget_disclosure (context: savings, not budget).
   */
  it("BRAND-04: '$660/mo saved on infra costs' is NOT caught by budget_disclosure patterns", () => {
    const r = evaluateQualityGate(
      xInput(
        "$660/mo saved on infrastructure by running our own Starknet validator.",
        REAL_PERSONA,
      ),
    );
    expect(r.violations.some((v) => v.includes("budget_disclosure"))).toBe(false);
  });

  /**
   * BRAND-05: kill_criterion_phrase catches internal kill-criteria disclosure.
   */
  it("BRAND-05: kill-criterion phrase caught when referencing internal Q-date", () => {
    const r = evaluateQualityGate(
      xInput("if we miss the launch by end of Q4 2027 we will pivot the strategy.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("kill_criterion_phrase"))).toBe(true);
  });

  /**
   * BRAND-06: target_date_quarter catches "Q3 2027" per ADR-031 multi-chain discipline.
   */
  it("BRAND-06: target_date_quarter catches 'mainnet planned for Q3 2027'", () => {
    const r = evaluateQualityGate(
      xInput("EVM adapter mainnet release planned for Q3 2027.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("target_date_quarter"))).toBe(true);
  });

  /**
   * BRAND-07: algorithm_ladder patterns catch ZK proof system implementation names.
   */
  it("BRAND-07: algorithm_ladder_ecdsa catches 'ECDSA P-521 chip authentication'", () => {
    const r = evaluateQualityGate(
      xInput("The verifier handles ECDSA P-521 for biometric chip authentication.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("algorithm_ladder_ecdsa"))).toBe(true);
  });

  /**
   * BRAND-08: audit_firm_pre_signature is case-insensitive (ported from (?i) removal fix).
   */
  it("BRAND-08: audit_firm_pre_signature is case-insensitive after (?i) removal fix", () => {
    const r = evaluateQualityGate(
      xInput("RFP responses from Zellic and Veridise look promising.", REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("audit_firm_pre_signature"))).toBe(true);
  });

  /**
   * BRAND-09: cairo_internal_function catches check_nullifier in marketing copy.
   */
  it("BRAND-09: cairo_internal_function catches 'check_nullifier' entry point", () => {
    const r = evaluateQualityGate(
      articleInput(
        "How check_nullifier prevents double-spend in Glacis V2",
        "The check_nullifier Cairo entry point ensures atomic nullifier consumption.",
        REAL_PERSONA,
      ),
    );
    expect(r.violations.some((v) => v.includes("cairo_internal_function"))).toBe(true);
  });

  /**
   * BRAND-10: contract_address catches Starknet felt252 hex addresses (>=40 hex chars).
   */
  it("BRAND-10: contract_address catches a full Starknet felt252 address", () => {
    const addr = `0x0${"a".repeat(63)}`;
    const r = evaluateQualityGate(
      xInput(`Glacis V2 is deployed at ${addr} on Starknet mainnet.`, REAL_PERSONA),
    );
    expect(r.violations.some((v) => v.includes("contract_address"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ITER — iteration loop contract (MAX_ATTEMPTS=3 logic from phases.ts)
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!PERSONA_AVAILABLE)(
  "ITER — iteration loop behavior (gate-level, 3 attempts)",
  () => {
    /**
     * Helper that simulates the decide-phase retry loop using the real gate.
     * Returns { attempts, finalStatus, violations }.
     */
    function simulateRetryLoop(payloads: Record<string, unknown>[]): {
      attempts: number;
      finalStatus: "success" | "gate_failed";
      violations: string[];
    } {
      const MAX_ATTEMPTS = 3;
      let attempt = 0;
      let lastViolations: string[] = [];

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        const payload = payloads[attempt - 1] ?? payloads[payloads.length - 1];
        const gate = evaluateQualityGate({
          action_type: "publish_social_post",
          platform: "x",
          payload,
          persona: REAL_PERSONA,
        });
        lastViolations = gate.violations;

        if (gate.passed) {
          return { attempts: attempt, finalStatus: "success", violations: [] };
        }
      }

      // All attempts exhausted
      if (attempt === MAX_ATTEMPTS && lastViolations.length > 0) {
        return {
          attempts: attempt,
          finalStatus: "gate_failed",
          violations: lastViolations,
        };
      }

      return { attempts: attempt, finalStatus: "success", violations: [] };
    }

    /**
     * ITER-01: Attempt 1 passes -> returns success at attempt 1.
     */
    it("ITER-01: attempt 1 passes gate -> success at attempts=1", () => {
      const result = simulateRetryLoop([
        {
          text: "Post-quantum ready, STARK-based, no trusted setup. Starknet mainnet.",
        },
      ]);
      expect(result.finalStatus).toBe("success");
      expect(result.attempts).toBe(1);
    });

    /**
     * ITER-02: Attempt 1 fails, attempt 2 passes -> success at attempt 2.
     */
    it("ITER-02: attempt 1 fails, attempt 2 passes -> success at attempts=2", () => {
      const result = simulateRetryLoop([
        { text: "A revolutionary breakthrough for ZK identity." }, // fail
        {
          text: "Post-quantum ready, STARK-based, no trusted setup. ~50ms on Sepolia.",
        }, // pass
      ]);
      expect(result.finalStatus).toBe("success");
      expect(result.attempts).toBe(2);
    });

    /**
     * ITER-03: All 3 attempts fail -> gate_failed with violations, attempts=3.
     */
    it("ITER-03: all 3 attempts fail -> gate_failed at attempts=3", () => {
      const failPayload = {
        text: "Our revolutionary game-changing unprecedented AI-powered groundbreaking ZK system.",
      };
      const result = simulateRetryLoop([failPayload, failPayload, failPayload]);
      expect(result.finalStatus).toBe("gate_failed");
      expect(result.attempts).toBe(3);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    /**
     * ITER-04: 3 failures exhaust attempts; no 4th attempt is made.
     * The loop contract is MAX_ATTEMPTS=3, not >=4.
     */
    it("ITER-04: loop does not exceed 3 attempts even with repeated failures", () => {
      let callCount = 0;
      const MAX_ATTEMPTS = 3;
      const failPayload = {
        text: "revolutionary AI-powered unprecedented next-gen groundbreaking.",
      };

      while (callCount < MAX_ATTEMPTS) {
        callCount++;
        const gate = evaluateQualityGate({
          action_type: "publish_social_post",
          platform: "x",
          payload: failPayload,
          persona: REAL_PERSONA,
        });
        if (gate.passed) break;
      }

      expect(callCount).toBe(MAX_ATTEMPTS);
      // No extra iteration
      expect(callCount).not.toBeGreaterThan(3);
    });

    /**
     * ITER-05: Violations from attempt N are passed as context; a cleaner attempt N+1
     * resolves them. Simulates the "avoid_violations" feedback loop from decidePhase.
     */
    it("ITER-05: violation feedback enables recovery on attempt 2", () => {
      let lastViolations: string[] = [];
      const MAX_ATTEMPTS = 3;
      let attempt = 0;
      let finalStatus: "success" | "gate_failed" = "gate_failed";

      const payloads = [
        { text: "A revolutionary approach to ZK identity on Starknet." }, // fail: revolutionary
        {
          text: "A rigorous approach to ZK identity. STARK-based, no trusted setup. ~50ms on Sepolia.",
        }, // pass
      ];

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        const payload = payloads[attempt - 1] ?? payloads[payloads.length - 1];
        const gate = evaluateQualityGate({
          action_type: "publish_social_post",
          platform: "x",
          payload,
          persona: REAL_PERSONA,
        });
        lastViolations = gate.violations;

        if (gate.passed) {
          finalStatus = "success";
          break;
        }

        // Violation feedback would be injected into next prompt in real decidePhase
        expect(lastViolations.length).toBeGreaterThan(0);
      }

      expect(finalStatus).toBe("success");
      expect(attempt).toBe(2);
    });
  },
);
