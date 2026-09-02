/**
 * Focused coverage for the `acceptance-criteria-present` anchor lens.
 *
 * The regression this pins (usine V2 run 4633499f, 2026-07-21). The usine
 * `feature` template's `spec` stage runs through the Claude Agent SDK, whose
 * executor wraps a stage artifact as `{ kind, route, text, structuredOutput, ...}`.
 * When `spec` declares an `artifactSchema`, the model's `acceptance_criteria`
 * array lands under `structuredOutput`, NOT at the artifact top level ; the lens
 * used to read only the top level, so it killed every real SDK-produced spec and
 * Citadel denied the envelope (422 decisionCore not admitted). The lens now reads
 * either location, which changes no signed-artifact surface (both fields already
 * exist on the artifact ; nothing new is spread to the top level).
 */

import { describe, expect, it } from "vitest";

import { ANCHOR_CHECKS } from "./anchor-checks.js";

const check = ANCHOR_CHECKS["acceptance-criteria-present"];

describe("acceptance-criteria-present anchor", () => {
  it("passes on a top-level acceptance_criteria array (a producer emitting the spec object directly)", () => {
    const artifact = JSON.stringify({ acceptance_criteria: ["do X", "do Y"], scope: {} });
    expect(check(artifact).pass).toBe(true);
  });

  it("passes when the array is nested under structuredOutput (the real Claude Agent SDK wrapper)", () => {
    const artifact = JSON.stringify({
      kind: "claude-agent",
      route: "gateway",
      text: '{"acceptance_criteria":["do X","do Y","do Z"]}',
      structuredOutput: { acceptance_criteria: ["do X", "do Y", "do Z"], scope: { summary: "s" } },
      numTurns: 2,
    });
    expect(check(artifact).pass).toBe(true);
  });

  it("fails when neither the top level nor structuredOutput carries the array (the run-4633499f 422)", () => {
    const artifact = JSON.stringify({
      kind: "claude-agent",
      route: "gateway",
      text: "a prose spec with the words acceptance criteria in it",
      structuredOutput: null,
    });
    const r = check(artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toContain("acceptance_criteria");
  });

  it("fails when the array (nested) has no non-empty entry", () => {
    const artifact = JSON.stringify({ structuredOutput: { acceptance_criteria: ["", "   "] } });
    expect(check(artifact).pass).toBe(false);
  });

  it("does not treat a non-object structuredOutput as a carrier", () => {
    const artifact = JSON.stringify({ structuredOutput: "acceptance_criteria: none" });
    expect(check(artifact).pass).toBe(false);
  });

  it("prefers a valid top-level array even when structuredOutput is absent", () => {
    const artifact = JSON.stringify({ acceptance_criteria: ["only top-level"] });
    expect(check(artifact).pass).toBe(true);
  });
});

// Same regression class, `implement` stage (usine V2 run db81a5c0, 2026-07-22):
// the SDK executor wraps the implement report the same way, so `changed_files`
// lands under `structuredOutput` once the stage declares an artifactSchema.
describe("diff-nonempty reads structuredOutput", () => {
  const diff = ANCHOR_CHECKS["diff-nonempty"];

  it("passes when changed_files is nested under structuredOutput (the real Claude Agent SDK wrapper)", () => {
    const artifact = JSON.stringify({
      kind: "claude-agent",
      route: "gateway",
      text: "summary prose",
      structuredOutput: {
        changed_files: ["asyncapi.yaml", "src/__tests__/codegen.test.ts"],
        summary: "added vault.withdrawn",
      },
      numTurns: 52,
    });
    expect(diff(artifact).pass).toBe(true);
  });

  it("fails when neither location carries the array (the run-db81a5c0 422)", () => {
    const artifact = JSON.stringify({
      kind: "claude-agent",
      route: "gateway",
      text: "Everything is in order. Here's a summary of all changes made ...",
      structuredOutput: null,
    });
    const r = diff(artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toContain("changed_files");
  });

  it("fails when the nested array holds only blank entries", () => {
    const artifact = JSON.stringify({ structuredOutput: { changed_files: ["", "  "] } });
    expect(diff(artifact).pass).toBe(false);
  });

  it("prefers a valid top-level array even when structuredOutput is absent", () => {
    const artifact = JSON.stringify({ changed_files: ["a.ts"] });
    expect(diff(artifact).pass).toBe(true);
  });
});

describe("gtm-post content anchors (mur ; Phase 3 GTM template)", () => {
  it("materiality-declared passes on a well-shaped materiality artifact", () => {
    const artifact = JSON.stringify({
      structuredOutput: {
        has_materiality: true,
        angle: "Glacis mainnet verifier throughput",
        reasoning: "New benchmark landed in Citadel sprint-1028 yesterday.",
        format_hint: "single",
        sources: ["citadel:sprint-1028:t9"],
      },
    });
    const r = ANCHOR_CHECKS["materiality-declared"](artifact);
    expect(r.pass).toBe(true);
  });

  it("materiality-declared fails closed when has_materiality is missing", () => {
    const artifact = JSON.stringify({ structuredOutput: { angle: "x" } });
    const r = ANCHOR_CHECKS["materiality-declared"](artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toContain("has_materiality");
  });

  it("materiality-declared accepts has_materiality:false (a legitimate quiet day)", () => {
    const artifact = JSON.stringify({
      structuredOutput: {
        has_materiality: false,
        angle: "",
        reasoning: "nothing new",
        format_hint: "single",
        sources: [],
      },
    });
    const r = ANCHOR_CHECKS["materiality-declared"](artifact);
    expect(r.pass).toBe(true);
  });

  it("char-limit-respected passes when every post is <=280 chars", () => {
    const artifact = JSON.stringify({
      structuredOutput: { posts: ["a".repeat(279)], format: "single" },
    });
    expect(ANCHOR_CHECKS["char-limit-respected"](artifact).pass).toBe(true);
  });

  it("char-limit-respected fails when any post exceeds 280 chars", () => {
    const artifact = JSON.stringify({
      structuredOutput: { posts: ["a".repeat(281)], format: "single" },
    });
    const r = ANCHOR_CHECKS["char-limit-respected"](artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toContain("281");
  });

  it("char-limit-respected checks every post in a thread, not just the first", () => {
    const artifact = JSON.stringify({
      structuredOutput: { posts: ["short", "b".repeat(300)], format: "thread" },
    });
    expect(ANCHOR_CHECKS["char-limit-respected"](artifact).pass).toBe(false);
  });

  it("no-forbidden-style fails on an em-dash in any post", () => {
    const artifact = JSON.stringify({
      structuredOutput: { posts: ["Glacis ships fast — proven on mainnet."] },
    });
    const r = ANCHOR_CHECKS["no-forbidden-style"](artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toMatch(/em.dash/i);
  });

  it("no-forbidden-style fails on a forbidden adjective", () => {
    const artifact = JSON.stringify({ structuredOutput: { posts: ["Glacis is revolutionary."] } });
    expect(ANCHOR_CHECKS["no-forbidden-style"](artifact).pass).toBe(false);
  });

  it("no-forbidden-style passes clean, numbers-first copy", () => {
    const artifact = JSON.stringify({
      structuredOutput: {
        posts: ["Glacis verified 1024 STARK proofs in 40ms median on Starknet mainnet."],
      },
    });
    expect(ANCHOR_CHECKS["no-forbidden-style"](artifact).pass).toBe(true);
  });

  it("hashtags-present fails when no post carries a hashtag or mention", () => {
    const artifact = JSON.stringify({
      structuredOutput: { posts: ["Glacis verified 1024 proofs today."] },
    });
    const r = ANCHOR_CHECKS["hashtags-present"](artifact);
    expect(r.pass).toBe(false);
    expect(r.rationale).toContain("hashtag");
  });

  it("hashtags-present passes with a hashtag on at least one post", () => {
    const artifact = JSON.stringify({ structuredOutput: { posts: ["Glacis ships. #Starknet"] } });
    expect(ANCHOR_CHECKS["hashtags-present"](artifact).pass).toBe(true);
  });

  it("hashtags-present passes with an @mention instead of a hashtag", () => {
    const artifact = JSON.stringify({ structuredOutput: { posts: ["Built on @Starknet."] } });
    expect(ANCHOR_CHECKS["hashtags-present"](artifact).pass).toBe(true);
  });

  // `no-competitor-mention` is ENGINE-grounded (see ENGINE_GROUNDED_ANCHORS
  // in anchor-checks.ts), not a pure ANCHOR_CHECKS entry ; it has no self-
  // attested draft-bytes path to test here. Its behavior is covered by
  // `usine-engine/test/executor/content-verify.test.ts` (`computeNoCompetitorMention`)
  // against the product's REGISTERED competitor list, resolved server-side.
});
