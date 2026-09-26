/**
 * Tests for the `pq_verifier_unavailable` refusal reason in
 * packages/agent-sdk/src/proof/cert-verify.ts.
 *
 * Kept in a dedicated file (no static import of cert-verify.js) so the
 * module-level `_mlDsa44` memoization in `loadMlDsa44()` cannot already be
 * warmed with a real `@noble/post-quantum` module by another test in the
 * same file — mirrors the split used by
 * tests/create-agent-metrics.test.ts / tests/metrics-create-agent-metrics.test.ts
 * for the same reason with `prom-client`.
 *
 * Uses `vi.doMock` (not `vi.mock`) deliberately: `vi.mock`/`vi.unmock` calls
 * are hoisted to the top of the module by vitest's transform regardless of
 * where they appear in the file, so a same-test `vi.mock(...)` followed by
 * `vi.unmock(...)` would both run before the test body executes and cancel
 * each other out. `vi.doMock` is not hoisted, so it takes effect exactly
 * where it is called — required here since the mock must be scoped to this
 * one test.
 */

import { describe, expect, it, vi } from "vitest";

describe("verifyRunCertificate — ML-DSA-44 without @noble/post-quantum installed", () => {
  it("returns pq_verifier_unavailable, never a false accept, when the optional dep is missing", async () => {
    // Simulate `@noble/post-quantum` missing by making the lazy createRequire
    // loader throw for it specifically, mirroring the loadPromClient test.
    vi.doMock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "@noble/post-quantum/ml-dsa.js") throw new Error("MODULE_NOT_FOUND");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(id);
      },
    }));
    vi.resetModules();

    const mod = await import("../src/proof/cert-verify.js");

    const cert = { runId: "run-pq-unavailable" };
    const recomputed = mod.computeCertHashFelt252(cert);

    // Well-formed in every other respect (right hash, plausible lengths) —
    // the only thing wrong is the missing verifier. Must never verify as true.
    const r = mod.verifyRunCertificate({
      ...cert,
      signature: {
        alg: "ML-DSA-44",
        kid: "k-pq",
        value: Buffer.alloc(2420).toString("base64"),
        pubkey_b64: Buffer.alloc(1312).toString("base64"),
        cert_hash_felt252: recomputed,
        signed_at: "",
      },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("pq_verifier_unavailable");

    // An Ed25519 cert must still be checkable without the PQ dependency —
    // the point of making it optional. missing_signature proves the module
    // loaded and ran normally instead of throwing.
    const r2 = mod.verifyRunCertificate({ runId: "run-1" });
    expect(r2.reason).toBe("missing_signature");

    vi.doUnmock("node:module");
    vi.resetModules();
  });
});
