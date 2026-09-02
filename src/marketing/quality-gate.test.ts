import { describe, expect, it } from "vitest";
import type { AgentPersona } from "../identity/persona-schema.js";
import { evaluateQualityGate } from "./quality-gate.js";

const EMPTY_PERSONA: AgentPersona = {};

/**
 * Marketing-grade persona fixture replicating the rules that the Forge-local
 * gate hard-coded (IP leak patterns + adjective rejection + must-not
 * directives). Persona-driven equivalent of the legacy regex bank.
 */
const MARKETING_PERSONA: AgentPersona = {
  forbidden_patterns: [
    { name: "forbidden_adjective_revolutionary", pattern: "\\brevolutionary\\b" },
    { name: "forbidden_adjective_groundbreaking", pattern: "\\bgroundbreaking\\b" },
    { name: "rsa_algorithm_ladder", pattern: "RSA-?\\{[\\d,\\s-]+\\}|RSA-(?:2048|3072|4096|6144)" },
    { name: "ecdsa_curve_dump", pattern: "(ECDSA|secp\\d+r\\d+|brainpool[Pp]\\d+[rt]?\\d+)" },
    {
      name: "cairo_internals",
      pattern: "\\b(GlacisVerifier|CaRegistry contract|Cairo unit tests?)\\b",
    },
    { name: "audit_firm_named_publicly", pattern: "\\b(Trail of Bits|Zellic|Veridise)\\b" },
    {
      name: "looking_for_n_partners",
      pattern: "looking for \\d+(?:[-–]\\d+)?\\s+(?:\\S+\\s+){0,3}?partners?",
    },
    { name: "starknet_contract_addr", pattern: "0x0?[0-9a-f]{60,64}" },
    { name: "github_private_repo", pattern: "github\\.com/[\\w-]+/[\\w-]+\\s*\\(private\\)" },
  ],
  directives: {
    must_not: ["next-gen", "unprecedented breakthrough"],
  },
};

describe("evaluateQualityGate ; persona-driven content checks", () => {
  it("passes on clean payload with empty persona", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: { platform: "x", text: "A normal tweet under the limit." },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it("surfaces persona forbidden_pattern matches as violations with pattern name + preview", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "Our revolutionary new approach to identity is here.",
      },
      persona: MARKETING_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("forbidden_adjective_revolutionary"))).toBe(true);
    expect(r.violations.some((v) => v.includes('"revolutionary"'))).toBe(true);
  });

  it("surfaces persona directive must_not matches as warnings (not violations)", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "Our next-gen infrastructure ships today.",
      },
      persona: MARKETING_PERSONA,
    });
    expect(r.passed).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("must_not") && w.includes("next-gen"))).toBe(true);
  });

  it("x platform : tweet over 280 chars surfaces structural violation", () => {
    const longText = "a".repeat(1300);
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: { platform: "x", text: longText },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("exceeds 280"))).toBe(true);
  });

  it("x platform : thread of 11 entries (root+10 replies) surfaces structural violation", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "root",
        thread: ["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"],
      },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("exceeds max 10"))).toBe(true);
  });

  it("x platform : thread of 8 entries (root+7) passes structural check", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "root",
        thread: ["t2", "t3", "t4", "t5", "t6", "t7", "t8"],
      },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(true);
  });

  it("x platform : thread of 10 entries (root+9) passes structural check (prompt intent upper bound)", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "root",
        thread: ["t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"],
      },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(true);
  });

  it("x platform : thread of 4 entries (root+3) passes structural check", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "root",
        thread: ["t2", "t3", "t4"],
      },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(true);
  });

  it("linkedin platform : body of 1300 chars exceeds max", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "linkedin",
      payload: { platform: "linkedin", text: "x".repeat(1301) },
      persona: EMPTY_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("linkedin"))).toBe(true);
  });

  it("regression : Glacis V2 X thread (2026-05-20 incident) ; persona catches rsa_algorithm_ladder + ecdsa_curve_dump + cairo_internals + audit firms + partner count", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: {
        platform: "x",
        text: "Glacis V2 trustless verifier is on Starknet mainnet since yesterday. 33 country root certificates registered.",
        thread: [
          "Most zk-passport projects end-2025 supported 3-5 countries. Belgium=RSA-2048. Poland=RSA-3072. Korea=ECDSA secp384r1.",
          "Cairo circuit covers RSA-{2048,3072,4096,6144} + ECDSA secp384r1 + brainpoolP256r1. GlacisVerifier deployed.",
          "Audit RFPs sent today to Trail of Bits, Zellic, Veridise.",
          "Looking for 2-3 integration design partners.",
        ],
      },
      persona: MARKETING_PERSONA,
    });
    expect(r.passed).toBe(false);
    const violationText = r.violations.join("\n");
    expect(violationText).toMatch(/rsa_algorithm_ladder/);
    expect(violationText).toMatch(/ecdsa_curve_dump/);
    expect(violationText).toMatch(/cairo_internals/);
    expect(violationText).toMatch(/audit_firm_named_publicly/);
    expect(violationText).toMatch(/looking_for_n_partners/);
  });

  it("empty payload fails the gate up-front", () => {
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: null,
      persona: MARKETING_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("empty"))).toBe(true);
  });

  it("publish_article : scans title + content + excerpt", () => {
    const r = evaluateQualityGate({
      action_type: "publish_article",
      payload: {
        title: "Our groundbreaking new approach",
        content: "Long form content here.",
        excerpt: "Short excerpt.",
      },
      persona: MARKETING_PERSONA,
    });
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("title") && v.includes("groundbreaking"))).toBe(
      true,
    );
  });

  it("cold mail : scans subject + body ; structural rules do NOT apply (no platform check)", () => {
    const r = evaluateQualityGate({
      action_type: "send_cold_mail",
      payload: {
        subject: "RFP follow-up",
        body: "Body referencing RSA-2048 algorithm.",
      },
      persona: MARKETING_PERSONA,
    });
    // RSA-2048 matches the rsa_algorithm_ladder pattern ; persona rules apply to cold mail too.
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes("rsa_algorithm_ladder"))).toBe(true);
  });

  it("invalid regex in persona surfaces as warning + violation (passed=false ; compile-error contract)", () => {
    // Contract change 2026-05-20: compile failure = HARD ERROR (passed=false), not WARN-only.
    // A malformed pattern provides zero protection; silently passing content through is the BUG-1
    // failure mode ((?i) inline flag, 22/32 patterns disabled for ~30 cycles).
    const persona: AgentPersona = {
      forbidden_patterns: [{ name: "bad", pattern: "[unclosed" }],
    };
    const r = evaluateQualityGate({
      action_type: "publish_social_post",
      platform: "x",
      payload: { platform: "x", text: "fine" },
      persona,
    });
    expect(r.passed).toBe(false); // compile failure blocks dispatch
    expect(r.warnings.some((w) => w.includes("invalid regex"))).toBe(true); // observability
    expect(r.violations.some((v) => v.includes("invalid regex"))).toBe(true); // hard block
  });

  it("persona pattern with scope filter only matches inside the declared scope", () => {
    const persona: AgentPersona = {
      forbidden_patterns: [{ name: "title_only_bad", pattern: "\\bbadword\\b", scope: "title" }],
    };
    const rTitle = evaluateQualityGate({
      action_type: "publish_article",
      payload: { title: "this has badword in title", content: "clean body" },
      persona,
    });
    expect(rTitle.passed).toBe(false);

    const rBody = evaluateQualityGate({
      action_type: "publish_article",
      payload: { title: "clean title", content: "this has badword in content" },
      persona,
    });
    expect(rBody.passed).toBe(true);
  });
});
