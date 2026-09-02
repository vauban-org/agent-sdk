/**
 * gate-envelope tests: the Delivery Control Plane keystone security contract.
 *
 * Proves the anti-fabrication / anti-replay properties the control plane relies
 * on: a signed envelope round-trips; any tamper of the signed surface fails the
 * signature; a wrong/forged outputHash is caught by recompute; acceptedHash must
 * equal artifactHash; and the deterministic-anchor floor is derived ONLY from the
 * signed verdicts (a missing / llm-judge / soft / fired anchor is rejected).
 *
 * Ref: docs/architecture/delivery-control-plane.md §7 (gate envelope).
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEd25519Signer,
  createEd25519Verifier,
} from "../../remote/signing.js";
import type {
  BatteryDecision,
  CandidateVerdict,
  LensVerdict,
} from "./types.js";
import {
  buildGateEnvelope,
  canonicalEnvelopeString,
  checkRequiredAnchors,
  type GateDecisionCore,
  type GateVerdictEnvelope,
  reconstructDecisionCore,
  recomputeOutputHash,
  signGateEnvelope,
  verifyGateEnvelope,
} from "./gate-envelope.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const sign = createEd25519Signer(privateKey);
const verify = createEd25519Verifier(publicKey);

function lensVerdict(over: Partial<LensVerdict> = {}): LensVerdict {
  return {
    lens: "json-schema",
    polarity: "affirm",
    criticality: "hard",
    engine: "rule",
    rawScore: 1,
    fired: false,
    rationale: "ok",
    ...over,
  };
}

function acceptedVerdict(lensVerdicts: LensVerdict[]): CandidateVerdict {
  return {
    candidateIndex: 0,
    candidateHash: "artifact-hash-abc",
    lensVerdicts,
    killed: false,
    killReason: null,
    compositeScore: 1,
  };
}

function core(over: Partial<GateDecisionCore> = {}): GateDecisionCore {
  return {
    kind: "verifier-battery",
    adrEco: "ADR-ECO-DELIVERY-FACTORY-V1",
    voteThreshold: 0.5,
    acceptedIndex: 0,
    acceptedHash: "artifact-hash-abc",
    acceptedScore: 1,
    verdicts: [acceptedVerdict([lensVerdict()])],
    rejected: [],
    ...over,
  };
}

async function envelope(
  c: GateDecisionCore,
  over: Partial<GateVerdictEnvelope> = {},
): Promise<GateVerdictEnvelope> {
  return {
    runId: "run-1",
    stageId: "spec",
    attempt: 1,
    commit: "deadbeef",
    producerId: "claude-code",
    keyid: "verifier-v1",
    artifactHash: c.acceptedHash ?? "",
    decisionCore: c,
    outputHash: await recomputeOutputHash(c),
    ...over,
  };
}

describe("gate-envelope sign/verify", () => {
  it("round-trips: a signed envelope verifies", async () => {
    const signed = signGateEnvelope(await envelope(core()), sign);
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it("rejects an unsigned envelope", async () => {
    const v = await verifyGateEnvelope(await envelope(core()), verify);
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain("missing signature");
  });

  it("detects tampering of any signed field (attempt); signature fails", async () => {
    const signed = signGateEnvelope(await envelope(core()), sign);
    const tampered: GateVerdictEnvelope = { ...signed, attempt: 99 };
    const v = await verifyGateEnvelope(tampered, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("signature"))).toBe(true);
  });

  it("rejects a forged outputHash even when the signature is valid over it", async () => {
    // sign an envelope whose outputHash does NOT match its decisionCore
    const bad = await envelope(core(), { outputHash: "0".repeat(64) });
    const signed = signGateEnvelope(bad, sign);
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("outputHash mismatch"))).toBe(true);
  });

  it("rejects a signature from the wrong key", async () => {
    const other = generateKeyPairSync("ed25519");
    const signWrong = createEd25519Signer(other.privateKey);
    const signed = signGateEnvelope(await envelope(core()), signWrong);
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("signature"))).toBe(true);
  });

  it("rejects acceptedHash != artifactHash", async () => {
    const signed = signGateEnvelope(
      await envelope(core(), { artifactHash: "different" }),
      sign,
    );
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(false);
    expect(
      v.reasons.some((r) =>
        r.includes("acceptedHash does not equal artifactHash"),
      ),
    ).toBe(true);
  });

  it("rejects a non-admitted decision (acceptedIndex null)", async () => {
    const signed = signGateEnvelope(
      await envelope(core({ acceptedIndex: null, acceptedHash: null })),
      sign,
    );
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("not admitted"))).toBe(true);
  });

  it("canonicalEnvelopeString excludes sig (signer and verifier agree)", async () => {
    const e = await envelope(core());
    const signed = signGateEnvelope(e, sign);
    expect(canonicalEnvelopeString(e)).toEqual(canonicalEnvelopeString(signed));
  });
});

describe("gate-envelope policy_digest (optional, signed)", () => {
  it("back-compat: an undefined policy_digest is byte-identical to a never-added field", async () => {
    // An envelope WITHOUT policy_digest must canonicalize exactly as if the field
    // did not exist on the type — so every prior seal still verifies. Compare a
    // literal-no-field object against one carrying `policy_digest: undefined`.
    const e = await envelope(core());
    const eExplicitUndefined: GateVerdictEnvelope = {
      ...e,
      policy_digest: undefined,
    };
    expect(canonicalEnvelopeString(eExplicitUndefined)).toEqual(
      canonicalEnvelopeString(e),
    );
    // and the canonical string contains no "policy_digest" key
    expect(canonicalEnvelopeString(e)).not.toContain("policy_digest");
  });

  it("back-compat: a verdict without policy_digest signs+verifies (signature unchanged)", async () => {
    const signed = signGateEnvelope(await envelope(core()), sign);
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(signed.policy_digest).toBeUndefined();
  });

  it("round-trips: an envelope WITH policy_digest signs then verifies", async () => {
    const e = await envelope(core(), {
      policy_digest: "policy-digest-sha256-xyz",
    });
    const signed = signGateEnvelope(e, sign);
    const v = await verifyGateEnvelope(signed, verify);
    expect(v.valid).toBe(true);
    expect(v.reasons).toEqual([]);
    // the digest entered the signed surface
    expect(canonicalEnvelopeString(e)).toContain(
      '"policy_digest":"policy-digest-sha256-xyz"',
    );
  });

  it("tampering the policy_digest after signing fails the signature", async () => {
    const signed = signGateEnvelope(
      await envelope(core(), { policy_digest: "original-digest" }),
      sign,
    );
    const tampered: GateVerdictEnvelope = {
      ...signed,
      policy_digest: "swapped-digest",
    };
    const v = await verifyGateEnvelope(tampered, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("signature"))).toBe(true);
  });

  it("stripping the policy_digest from a verdict that was signed with it fails the signature", async () => {
    const signed = signGateEnvelope(
      await envelope(core(), { policy_digest: "bound-digest" }),
      sign,
    );
    const { policy_digest: _dropped, ...stripped } = signed;
    const v = await verifyGateEnvelope(stripped as GateVerdictEnvelope, verify);
    expect(v.valid).toBe(false);
    expect(v.reasons.some((r) => r.includes("signature"))).toBe(true);
  });
});

describe("checkRequiredAnchors: deterministic floor from signed verdicts", () => {
  it("passes when the required anchor is a hard, non-llm-judge lens that did not fire", () => {
    const r = checkRequiredAnchors(core(), ["json-schema"]);
    expect(r.valid).toBe(true);
  });

  it("rejects a missing required anchor", () => {
    const r = checkRequiredAnchors(core(), ["nonempty-fields"]);
    expect(r.valid).toBe(false);
    expect(
      r.reasons.some((x) => x.includes("absent from signed verdict")),
    ).toBe(true);
  });

  it("rejects an llm-judge as the floor", () => {
    const c = core({
      verdicts: [acceptedVerdict([lensVerdict({ engine: "llm-judge" })])],
    });
    const r = checkRequiredAnchors(c, ["json-schema"]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("llm-judge"))).toBe(true);
  });

  it("rejects a soft anchor (cannot gate)", () => {
    const c = core({
      verdicts: [acceptedVerdict([lensVerdict({ criticality: "soft" })])],
    });
    const r = checkRequiredAnchors(c, ["json-schema"]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("not hard criticality"))).toBe(
      true,
    );
  });

  it("rejects a fired (failed) anchor; acceptance alone is not enough", () => {
    const c = core({
      verdicts: [acceptedVerdict([lensVerdict({ fired: true })])],
    });
    const r = checkRequiredAnchors(c, ["json-schema"]);
    expect(r.valid).toBe(false);
    expect(r.reasons.some((x) => x.includes("fired"))).toBe(true);
  });

  it("rejects when there is no accepted candidate", () => {
    const r = checkRequiredAnchors(core({ acceptedIndex: null }), [
      "json-schema",
    ]);
    expect(r.valid).toBe(false);
  });
});

describe("reconstructDecisionCore", () => {
  it("picks exactly the battery decisionCore fields", () => {
    const decision = {
      accepted: { foo: 1 },
      acceptedIndex: 0,
      acceptedHash: "h",
      acceptedScore: 0.9,
      verdicts: [acceptedVerdict([lensVerdict()])],
      rejected: [],
      adrEco: "ADR-X",
      voteThreshold: 0.5,
      auditStep: { outputHash: "ignored" },
    } as unknown as BatteryDecision;
    const c = reconstructDecisionCore(decision);
    expect(c).toEqual({
      kind: "verifier-battery",
      adrEco: "ADR-X",
      voteThreshold: 0.5,
      acceptedIndex: 0,
      acceptedHash: "h",
      acceptedScore: 0.9,
      verdicts: decision.verdicts,
      rejected: decision.rejected,
    });
  });

  it("buildGateEnvelope takes artifactHash + outputHash from the decision", async () => {
    const c = core();
    const outputHash = await recomputeOutputHash(c);
    const decision = {
      ...c,
      accepted: {},
      auditStep: { outputHash },
    } as unknown as BatteryDecision;
    const e = buildGateEnvelope(
      {
        runId: "r",
        stageId: "spec",
        attempt: 1,
        commit: "c",
        producerId: "p",
        keyid: "k",
      },
      decision,
    );
    expect(e.artifactHash).toBe(c.acceptedHash);
    expect(e.outputHash).toBe(outputHash);
    // and the assembled envelope verifies after signing
    const v = await verifyGateEnvelope(signGateEnvelope(e, sign), verify);
    expect(v.valid).toBe(true);
  });
});
