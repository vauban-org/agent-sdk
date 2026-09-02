/**
 * teammate-message.test.ts — unit matrix for the governed teammate-message
 * envelope (TM1, packages/cli/docs/teammates-plan.md).
 *
 * Covers: envelope build determinism under an injected clock plus a real
 * Ed25519 signer; claim accept/reject/edge (inform without capability, ask
 * without capability, ask in/out of the sender's attenuated scope, empty
 * body, over-limit body); signature verify roundtrip (valid, tampered,
 * missing); and audit-step shape for both an accepted and a denied claim
 * (the shape the TM0 TraceAccumulator in spawn-child-agent.ts folds).
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEd25519Signer, createEd25519Verifier } from "../remote/signing.js";
import { RecordedClock } from "../replay/clock.js";
import {
  type BuildTeammateEnvelopeInput,
  type BuildTeammateEnvelopeV2Input,
  MAX_TEAMMATE_BODY_BYTES,
  RECOGNIZED_CLAIM_KINDS,
  TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2,
  TeammateBodyTooLargeError,
  type TeammateEnvelope,
  TeammateEnvelopeInputError,
  type TeammateMessageClaim,
  buildTeammateEnvelope,
  buildTeammateEnvelopeV2,
  canonicalTeammateEnvelopeString,
  isHitlGatableClaimKind,
  isRecognizedClaimKind,
  verifyMessageClaim,
  verifyTeammateEnvelopeSignature,
} from "./teammate-message.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const sign = createEd25519Signer(privateKey);
const verify = createEd25519Verifier(publicKey);

function baseInput(over: Partial<BuildTeammateEnvelopeInput> = {}): BuildTeammateEnvelopeInput {
  return {
    id: "msg-1",
    fromRunId: "run-a",
    toRunId: "run-b",
    claim: { kind: "inform" },
    body: "hello teammate",
    ...over,
  };
}

describe("buildTeammateEnvelope", () => {
  it("is deterministic under an injected clock and a real Ed25519 signer", () => {
    const envA = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([1000]),
      sign,
    });
    const envB = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([1000]),
      sign,
    });
    expect(envA).toEqual(envB);
    expect(envA.sentAt).toBe(1000);
    expect(typeof envA.sig).toBe("string");
    expect(envA.sig).not.toBe("");
  });

  it("builds the v1 envelope shape with no toName/broadcast field (adversarial #8)", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([2000]),
      sign,
    });
    expect(env.v).toBe(1);
    expect(env.id).toBe("msg-1");
    expect(env.fromRunId).toBe("run-a");
    expect(env.toRunId).toBe("run-b");
    expect(env).not.toHaveProperty("toName");
    expect(env).not.toHaveProperty("broadcast");
  });

  it("carries replyTo when supplied, and omits it entirely when absent", () => {
    const withReply = buildTeammateEnvelope(baseInput({ replyTo: "msg-0" }), {
      clock: new RecordedClock([2100]),
      sign,
    });
    expect(withReply.replyTo).toBe("msg-0");

    const withoutReply = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([2200]),
      sign,
    });
    expect(withoutReply).not.toHaveProperty("replyTo");
  });

  it("accepts an empty body", () => {
    const env = buildTeammateEnvelope(baseInput({ body: "" }), {
      clock: new RecordedClock([3000]),
      sign,
    });
    expect(env.body).toBe("");
    expect(typeof env.sig).toBe("string");
  });

  it("accepts a body at exactly MAX_TEAMMATE_BODY_BYTES", () => {
    const exact = "x".repeat(MAX_TEAMMATE_BODY_BYTES);
    const env = buildTeammateEnvelope(baseInput({ body: exact }), {
      clock: new RecordedClock([3500]),
      sign,
    });
    expect(env.body.length).toBe(MAX_TEAMMATE_BODY_BYTES);
  });

  it("rejects a body over MAX_TEAMMATE_BODY_BYTES", () => {
    const oversized = "x".repeat(MAX_TEAMMATE_BODY_BYTES + 1);
    expect(() =>
      buildTeammateEnvelope(baseInput({ body: oversized }), {
        clock: new RecordedClock([4000]),
        sign,
      }),
    ).toThrow(TeammateBodyTooLargeError);
  });

  it("rejects an empty fromRunId (fail-closed input validation)", () => {
    expect(() =>
      buildTeammateEnvelope(baseInput({ fromRunId: "" }), {
        clock: new RecordedClock([5000]),
        sign,
      }),
    ).toThrow(TeammateEnvelopeInputError);
  });

  it("rejects an unrecognised claim.kind", () => {
    expect(() =>
      buildTeammateEnvelope(baseInput({ claim: { kind: "broadcast" as never } }), {
        clock: new RecordedClock([6000]),
        sign,
      }),
    ).toThrow(TeammateEnvelopeInputError);
  });
});

describe("signature verify roundtrip", () => {
  it("round-trips: a signed envelope verifies", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([7000]),
      sign,
    });
    const v = verifyTeammateEnvelopeSignature(env, verify);
    expect(v.valid).toBe(true);
    expect(v.reason).toBeUndefined();
  });

  it("rejects a missing signature", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([8000]),
      sign,
    });
    const unsigned: TeammateEnvelope = { ...env, sig: undefined };
    const v = verifyTeammateEnvelopeSignature(unsigned, verify);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("missing signature");
  });

  it("detects tampering of any signed field", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([9000]),
      sign,
    });
    const tampered: TeammateEnvelope = { ...env, toRunId: "run-attacker" };
    const v = verifyTeammateEnvelopeSignature(tampered, verify);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("signature");
  });
});

describe("verifyMessageClaim", () => {
  it("accepts an inform claim without a capability", async () => {
    const env = buildTeammateEnvelope(baseInput({ claim: { kind: "inform" } }), {
      clock: new RecordedClock([10_000]),
      sign,
    });
    const verdict = await verifyMessageClaim(env, [], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("inform claim accepted");
  });

  it("rejects (fail-closed) an ask claim with no declared capability", async () => {
    const env = buildTeammateEnvelope(baseInput({ claim: { kind: "ask" } }), {
      clock: new RecordedClock([11_000]),
      sign,
    });
    const verdict = await verifyMessageClaim(env, ["get_task"], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("denied (fail-closed)");
    expect(verdict.reason).toContain("no capability declared");
  });

  it("accepts an ask claim whose capability is in the sender's attenuated scope", async () => {
    const env = buildTeammateEnvelope(
      baseInput({ claim: { kind: "ask", capability: "get_task" } }),
      {
        clock: new RecordedClock([12_000]),
        sign,
      },
    );
    const verdict = await verifyMessageClaim(env, ["get_task", "update_checkpoint"], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain('capability "get_task"');
  });

  it("rejects an ask claim whose capability is NOT in the sender's attenuated scope", async () => {
    const env = buildTeammateEnvelope(
      baseInput({ claim: { kind: "ask", capability: "delete_repo" } }),
      { clock: new RecordedClock([13_000]), sign },
    );
    const verdict = await verifyMessageClaim(env, ["get_task"], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("denied (fail-closed)");
    expect(verdict.reason).toContain('capability "delete_repo"');
  });

  it("normalizes mcp__server__ prefixes via the SAME baseToolName vocabulary as delegate.ts", async () => {
    const env = buildTeammateEnvelope(
      baseInput({ claim: { kind: "ask", capability: "get_task" } }),
      {
        clock: new RecordedClock([14_000]),
        sign,
      },
    );
    const verdict = await verifyMessageClaim(env, ["mcp__citadel__get_task"], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(true);
  });

  it("shapes the audit step for an accepted claim (folds into the TM0 accumulator)", async () => {
    const env = buildTeammateEnvelope(baseInput({ claim: { kind: "inform" } }), {
      clock: new RecordedClock([15_000]),
      sign,
    });
    const verdict = await verifyMessageClaim(env, [], {
      clock: new RecordedClock([100, 105]),
    });
    expect(verdict.auditStep.runId).toBe(env.fromRunId);
    expect(verdict.auditStep.phase).toBe("guard");
    expect(verdict.auditStep.type).toBe("guard_check");
    expect(verdict.auditStep.policy).toBe("hash-only");
    expect(verdict.auditStep.timestamp).toBe(100);
    expect(verdict.auditStep.durationMs).toBe(5);
    expect(typeof verdict.auditStep.outputHash).toBe("string");
    expect(verdict.auditStep).not.toHaveProperty("index");
    expect(verdict.auditStep).not.toHaveProperty("prevStepHash");
    expect(verdict.auditStep).not.toHaveProperty("stepHash");
  });

  it("shapes the audit step for a denied claim identically (accept vs denial is content, not shape)", async () => {
    const env = buildTeammateEnvelope(
      baseInput({ claim: { kind: "ask", capability: "delete_repo" } }),
      { clock: new RecordedClock([16_000]), sign },
    );
    const verdict = await verifyMessageClaim(env, ["get_task"], {
      clock: new RecordedClock([200, 210]),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.auditStep.runId).toBe(env.fromRunId);
    expect(verdict.auditStep.phase).toBe("guard");
    expect(verdict.auditStep.type).toBe("guard_check");
    expect(verdict.auditStep.policy).toBe("hash-only");
    expect(typeof verdict.auditStep.outputHash).toBe("string");
    expect(verdict.auditStep).not.toHaveProperty("index");
    expect(verdict.auditStep).not.toHaveProperty("prevStepHash");
    expect(verdict.auditStep).not.toHaveProperty("stepHash");
  });

  it("verifies a control claim on the agent-ask axis without ever describing it as an ask (this axis does not gate control ; receiver-side controllerControlScopeLens, ADR-ECO-118, is the actual gate)", async () => {
    const env = buildTeammateEnvelope(
      baseInput({ claim: { kind: "control", capability: "steer" } }),
      { clock: new RecordedClock([17_000]), sign },
    );
    // Empty attenuated scope on purpose: an "ask" for "steer" would fail-closed
    // here, but "control" is not gated on this axis at all (kind !== "ask"
    // always satisfies messageClaimScopeLens), so this always allows ; the
    // fact this axis allows is documented, not asserted blindly.
    const verdict = await verifyMessageClaim(env, [], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).not.toContain("ask claim");
    expect(verdict.reason).toContain("control claim accepted");
    expect(verdict.reason).toContain("ADR-ECO-118");
  });
});

// ─── buildTeammateEnvelopeV2 + verify-by-version (sprint-878, L2-A) ──────────

function baseV2Input(
  over: Partial<BuildTeammateEnvelopeV2Input> = {},
): BuildTeammateEnvelopeV2Input {
  return {
    id: "msg-2-1",
    fromRunId: "run-a",
    toRunId: "run-b",
    correlationId: "corr-1",
    claim: { kind: "inform" },
    body: "hello teammate v2",
    ...over,
  };
}

describe("buildTeammateEnvelopeV2", () => {
  it("builds a v2 envelope carrying schemaVersion + correlationId, no toSessionId when absent", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([20_000]),
      sign,
    });
    expect(env.v).toBe(2);
    expect(env.schemaVersion).toBe(TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2);
    expect(env.correlationId).toBe("corr-1");
    expect(env).not.toHaveProperty("toSessionId");
    expect(typeof env.sig).toBe("string");
  });

  it("carries toSessionId when supplied", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input({ toSessionId: "session-9" }), {
      clock: new RecordedClock([20_100]),
      sign,
    });
    expect(env.toSessionId).toBe("session-9");
  });

  it("is deterministic under an injected clock and a real Ed25519 signer", () => {
    const envA = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([21_000]),
      sign,
    });
    const envB = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([21_000]),
      sign,
    });
    expect(envA).toEqual(envB);
  });

  it("rejects an empty correlationId (fail-closed input validation)", () => {
    expect(() =>
      buildTeammateEnvelopeV2(baseV2Input({ correlationId: "" }), {
        clock: new RecordedClock([22_000]),
        sign,
      }),
    ).toThrow(TeammateEnvelopeInputError);
  });

  it("rejects a body over MAX_TEAMMATE_BODY_BYTES, same bound as v1", () => {
    const oversized = "x".repeat(MAX_TEAMMATE_BODY_BYTES + 1);
    expect(() =>
      buildTeammateEnvelopeV2(baseV2Input({ body: oversized }), {
        clock: new RecordedClock([23_000]),
        sign,
      }),
    ).toThrow(TeammateBodyTooLargeError);
  });
});

describe("verify-by-version (sprint-878 critical invariant)", () => {
  it("a v1 envelope's canonical bytes are unaffected by the v2 addition (no schemaVersion/correlationId leak)", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([30_000]),
      sign,
    });
    const bytes = canonicalTeammateEnvelopeString(env);
    expect(bytes).not.toContain("schemaVersion");
    expect(bytes).not.toContain("correlationId");
    expect(bytes).toContain('"v":1');
  });

  it("a v1 envelope verifies under v1 canonical bytes", () => {
    const env = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([31_000]),
      sign,
    });
    expect(verifyTeammateEnvelopeSignature(env, verify).valid).toBe(true);
  });

  it("a v2 envelope verifies under v2 canonical bytes", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([32_000]),
      sign,
    });
    expect(verifyTeammateEnvelopeSignature(env, verify).valid).toBe(true);
  });

  it("a v1 signature does NOT verify once re-stamped as a v2 envelope over the same logical content", () => {
    const v1 = buildTeammateEnvelope(baseInput(), {
      clock: new RecordedClock([33_000]),
      sign,
    });
    // Same logical fields, re-shaped as a v2 envelope but carrying the v1 sig
    // (simulates an attacker trying to replay a v1 signature against a v2
    // wire shape) ; the extra v2 fields change the signed bytes, so the OLD
    // signature must not verify.
    const forgedV2: TeammateEnvelope = {
      v: 2,
      schemaVersion: TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2,
      id: v1.id,
      fromRunId: v1.fromRunId,
      toRunId: v1.toRunId,
      correlationId: "corr-replay",
      sentAt: v1.sentAt,
      claim: v1.claim,
      body: v1.body,
      sig: v1.sig,
    };
    expect(verifyTeammateEnvelopeSignature(forgedV2, verify).valid).toBe(false);
  });

  it("a v2 signature does NOT verify once stripped down to the v1 field subset", () => {
    const v2 = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([34_000]),
      sign,
    });
    // Strip the v2-only fields and re-stamp as v1, keeping the v2 sig
    // (simulates an attacker trying to replay a v2 signature as a v1
    // envelope) ; the missing fields change the signed bytes, so the OLD
    // signature must not verify.
    const forgedV1: TeammateEnvelope = {
      v: 1,
      id: v2.id,
      fromRunId: v2.fromRunId,
      toRunId: v2.toRunId,
      sentAt: v2.sentAt,
      claim: v2.claim,
      body: v2.body,
      sig: v2.sig,
    };
    expect(verifyTeammateEnvelopeSignature(forgedV1, verify).valid).toBe(false);
  });

  it("detects tampering of a v2-only field (correlationId)", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([35_000]),
      sign,
    });
    const tampered: TeammateEnvelope = { ...env, correlationId: "corr-attacker" };
    const v = verifyTeammateEnvelopeSignature(tampered, verify);
    expect(v.valid).toBe(false);
  });

  it("detects tampering of a v2-only field (toSessionId)", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input({ toSessionId: "session-1" }), {
      clock: new RecordedClock([36_000]),
      sign,
    });
    const tampered: TeammateEnvelope = { ...env, toSessionId: "session-attacker" };
    const v = verifyTeammateEnvelopeSignature(tampered, verify);
    expect(v.valid).toBe(false);
  });
});

// ─── fromInstallId/toInstallId (L3-B D11, schemaVersion 2.1.0) ───────────────

describe("cross-install addressing fields (L3-B D11)", () => {
  it("carries fromInstallId/toInstallId when supplied, absent otherwise", () => {
    const withIds = buildTeammateEnvelopeV2(
      baseV2Input({ fromInstallId: "inst_aaaa", toInstallId: "inst_bbbb" }),
      { clock: new RecordedClock([40_000]), sign },
    );
    expect(withIds.fromInstallId).toBe("inst_aaaa");
    expect(withIds.toInstallId).toBe("inst_bbbb");

    const withoutIds = buildTeammateEnvelopeV2(baseV2Input(), {
      clock: new RecordedClock([40_100]),
      sign,
    });
    expect(withoutIds).not.toHaveProperty("fromInstallId");
    expect(withoutIds).not.toHaveProperty("toInstallId");
  });

  it("bumps schemaVersion to a 2.1.0 minor (D11)", () => {
    expect(TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2).toBe("2.1.0");
  });

  it("signature-binds fromInstallId: claiming a peer's id without their key fails verification", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input({ fromInstallId: "inst_real" }), {
      clock: new RecordedClock([40_200]),
      sign,
    });
    const spoofed: TeammateEnvelope = { ...env, fromInstallId: "inst_attacker" };
    expect(verifyTeammateEnvelopeSignature(spoofed, verify).valid).toBe(false);
  });

  it("old-v2-signature regression: a v2 envelope built before D11 (no fromInstallId/toInstallId) still verifies", () => {
    // Simulates a pre-D11 v2 envelope on the wire: the two new fields are
    // simply absent, never `undefined`-valued keys ; canonicalize() is
    // structural, so signed bytes for this shape are byte-identical to what
    // a pre-D11 sender produced, and this signature verifies unchanged.
    const preD11Shape: TeammateEnvelope = {
      v: 2,
      schemaVersion: "2.0.0",
      id: "msg-pre-d11",
      fromRunId: "run-a",
      toRunId: "run-b",
      correlationId: "corr-pre-d11",
      sentAt: 40_300,
      claim: { kind: "inform" },
      body: "hello from before D11",
    };
    const signed: TeammateEnvelope = {
      ...preD11Shape,
      sig: sign(canonicalTeammateEnvelopeString(preD11Shape)),
    };
    expect(verifyTeammateEnvelopeSignature(signed, verify).valid).toBe(true);
  });
});

// ─── list_targets claim kind (Z-C c1, adversarial #6 ; HITL-exempt) ──────────

describe("list_targets claim kind", () => {
  it("recognizes inform / ask / list_targets / control, and nothing else", () => {
    expect(isRecognizedClaimKind("inform")).toBe(true);
    expect(isRecognizedClaimKind("ask")).toBe(true);
    expect(isRecognizedClaimKind("list_targets")).toBe(true);
    // `control` (SP1 ; teammate-message.ts's "Control claim" section) joined
    // the recognized set alongside the pre-existing three ; this enumeration
    // tracks the full recognized vocabulary, not just the TM1 subset.
    expect(isRecognizedClaimKind("control")).toBe(true);
    // A kind a NEWER peer might send that this version predates : must NOT be
    // recognized, so the receiver drops it fail-closed (never mis-gates it).
    expect(isRecognizedClaimKind("execute_trade")).toBe(false);
    expect(isRecognizedClaimKind("")).toBe(false);
    expect([...RECOGNIZED_CLAIM_KINDS].sort()).toEqual([
      "ask",
      "control",
      "inform",
      "list_targets",
    ]);
  });

  it("classifies ONLY ask as HITL-gatable ; inform + list_targets are exempt by construction", () => {
    expect(isHitlGatableClaimKind("ask")).toBe(true);
    expect(isHitlGatableClaimKind("inform")).toBe(false);
    expect(isHitlGatableClaimKind("list_targets")).toBe(false);
    // "control" is HITL-exempt on THIS axis too ; it is gated RECEIVER-side by
    // controllerControlScopeLens (ADR-ECO-118, Task 2), never by this sender-
    // side "ask" HITL chain.
    expect(isHitlGatableClaimKind("control")).toBe(false);
  });

  it("builds + signs a list_targets envelope and it verifies round-trip", () => {
    const env = buildTeammateEnvelope(baseInput({ claim: { kind: "list_targets" } }), {
      clock: new RecordedClock([50_000]),
      sign,
    });
    expect(env.claim.kind).toBe("list_targets");
    expect(verifyTeammateEnvelopeSignature(env, verify).valid).toBe(true);
  });

  it("does NOT bump schemaVersion : a list_targets v2 envelope stays on the frozen 2.1.0 structure", () => {
    const env = buildTeammateEnvelopeV2(baseV2Input({ claim: { kind: "list_targets" } }), {
      clock: new RecordedClock([50_100]),
      sign,
    });
    // The claim vocabulary extended ; the envelope STRUCTURE did not, so the
    // schemaVersion (which versions the shape) stays frozen at 2.1.0.
    expect(env.schemaVersion).toBe(TEAMMATE_ENVELOPE_SCHEMA_VERSION_V2);
    expect(env.schemaVersion).toBe("2.1.0");
  });

  it("verifyMessageClaim allows a list_targets claim with no capability, like inform", async () => {
    const env = buildTeammateEnvelope(baseInput({ claim: { kind: "list_targets" } }), {
      clock: new RecordedClock([50_200]),
      sign,
    });
    // An empty attenuated scope : an ask would fail-closed here, list_targets
    // must not (it carries no capability to scope-check).
    const verdict = await verifyMessageClaim(env, [], {
      clock: new RecordedClock([1, 2]),
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("list_targets claim accepted");
  });

  it("rejects an unrecognized claim kind at build time (fail-closed sender-side)", () => {
    // Deliberately forge an out-of-vocabulary kind (routed through `unknown`,
    // never `any`) to prove the build-time guard rejects it.
    const forged = { kind: "execute_trade" } as unknown as TeammateMessageClaim;
    expect(() =>
      buildTeammateEnvelope(baseInput({ claim: forged }), {
        clock: new RecordedClock([50_300]),
        sign,
      }),
    ).toThrow(TeammateEnvelopeInputError);
  });
});
